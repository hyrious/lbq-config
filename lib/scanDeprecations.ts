import type { Checker, JSDocTagInfo, NodeHandle, Project, Symbol as TypeScriptSymbol } from 'typescript/unstable/sync';
import type { Node } from 'typescript/unstable/ast';

import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

type TypeScriptVersionModule = typeof import('typescript');
type TypeScriptSyncModule = typeof import('typescript/unstable/sync');
type TypeScriptAstModule = typeof import('typescript/unstable/ast');

interface TypeScriptModules {
	readonly version: TypeScriptVersionModule;
	readonly sync: TypeScriptSyncModule;
	readonly ast: TypeScriptAstModule;
}

interface NamedNode extends Node {
	readonly name?: Node;
}

export interface Deprecation {
	readonly projectPath: string;
	readonly file: string;
	readonly line: number; // 1-based
	readonly character: number; // 1-based
	readonly message: string;
}

export class DeprecationsScanner {
	constructor(readonly cwd: string = process.cwd()) { }

	private static readonly deprecatedMessage = 'Deprecated API';
	private static readonly sgrPattern = /\x1B\[[0-9;]*m/g;
	private static readonly identifierStartPattern = /[$_\p{ID_Start}]/u;
	private static readonly identifierPartPattern = /[$_\u200C\u200D\p{ID_Continue}]/u;

	private ts: TypeScriptModules | null = null;
	async loadTypeScript(): Promise<TypeScriptModules> {
		if (this.ts) {
			return this.ts;
		}
		this.ts = {
			version: await import('typescript') as TypeScriptVersionModule,
			sync: await import('typescript/unstable/sync') as TypeScriptSyncModule,
			ast: await import('typescript/unstable/ast') as TypeScriptAstModule
		};
		console.log(`Using bundled TypeScript ${this.ts.version.version}`);
		return this.ts;
	}

	async *scan(silent = false): AsyncIterable<Deprecation> {
		let projects = globSync('**/tsconfig.json', { exclude: ['node_modules', 'scripts'], cwd: this.cwd });

		if (!silent) {
			const { multiselect, isCancel } = await import('@clack/prompts');
			const response = await multiselect({
				message: 'Select one or more projects to run ts check',
				options: projects.map(e => ({ label: e, value: e })),
				initialValues: projects
			});
			if (isCancel(response) || !response.length) {
				return;
			}
			projects = response;
		}

		await this.loadTypeScript();
		for (const project of projects) {
			yield* this.scanProject(project);
		}
	}

	async *scanProject(configPath: string): AsyncIterable<Deprecation> {
		const ts = await this.loadTypeScript();
		const api = new ts.sync.API({ cwd: this.cwd });
		const deprecations: Deprecation[] = [];
		const seen = new Set<string>();
		const projectPath = resolve(this.cwd, dirname(configPath));
		let snapshot: InstanceType<TypeScriptSyncModule['Snapshot']> | null = null;
		try {
			snapshot = api.updateSnapshot({ openProjects: [configPath] });
		} catch (error) {
			console.error(`Failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
			api.close();
			return;
		}

		try {
			const project = snapshot.getProject(configPath) ?? snapshot.getProjects()[0];
			if (!project) {
				console.error(`Failed to load ${configPath}: no TypeScript project was created.`);
				return;
			}
			const configErrors = project.program.getConfigFileParsingDiagnostics();
			if (configErrors.length) {
				console.error(`Failed to parse ${configPath}: ${configErrors.map(e => e.text).join(', ')}`);
				return;
			}
			const checker = project.checker;
			for (const fileName of project.program.getSourceFileNames()) {
				const sourceFile = project.program.getSourceFile(fileName);
				if (!sourceFile || sourceFile.isDeclarationFile) continue;
				const visit = (node: Node): void => {
					const result = this.getDeprecationAtNode(node, checker, project, ts);
					if (result) {
						const { line, character } = sourceFile.getLineAndCharacterOfPosition(result.location.getStart());
						const deprecation: Deprecation = {
							projectPath,
							file: relative(projectPath, sourceFile.fileName),
							line: line + 1,
							character: character + 1,
							message: result.message.replaceAll(/\s+/g, ' ').trim()
						};
						const key = `${deprecation.file}:${deprecation.line}:${deprecation.character}:${deprecation.message}`;
						if (!seen.has(key)) {
							seen.add(key);
							deprecations.push(deprecation);
						}
					}
					node.forEachChild(visit);
				};
				visit(sourceFile);
			}
		} finally {
			snapshot.dispose();
			api.close();
		}
		yield* deprecations;
	}

	private getDeprecationAtNode(node: Node, checker: Checker, project: Project, ts: TypeScriptModules): { location: Node; message: string; } | null {
		const ast = ts.ast;
		if (ast.isTaggedTemplateExpression(node)) {
			const signature = checker.getResolvedSignature(node);
			const message = this.getDeprecationFromNodeHandle(signature?.declaration, project, ast);
			if (message) {
				return { location: node.tag, message };
			}
			return null;
		}

		if (ast.isCallExpression(node) || ast.isNewExpression(node)) {
			const signature = checker.getResolvedSignature(node);
			const message = this.getDeprecationFromNodeHandle(signature?.declaration, project, ast);
			if (message) {
				return { location: node.expression, message };
			}
			return null;
		}

		if (!this.isReferenceNode(node, ast) || this.shouldSkipReferenceNode(node, ast)) {
			return null;
		}

		const symbol = this.getSymbolAtLocation(node, checker, ts);
		const message = symbol ? this.getDeprecationFromSymbol(symbol, checker, project, ts) : null;
		return message ? { location: node, message } : null;
	}

	private getSymbolAtLocation(node: Node, checker: Checker, ts: TypeScriptModules): TypeScriptSymbol | null {
		const symbol = checker.getSymbolAtLocation(node);
		if (!symbol) {
			return null;
		}
		if (symbol.flags & ts.sync.SymbolFlags.Alias) {
			return checker.getAliasedSymbol(symbol);
		}
		return symbol;
	}

	private getDeprecationFromSymbol(symbol: TypeScriptSymbol, checker: Checker, project: Project, ts: TypeScriptModules): string | null {
		const declarations = symbol.declarations ?? [];
		const declaration = symbol.valueDeclaration ?? declarations[0];
		const message = this.getDeprecationFromNodeHandle(declaration, project, ts.ast);
		if (message) {
			return message;
		}
		if (declarations.length > 1) {
			return null;
		}
		return this.getDeprecationFromJsDocTags(symbol.getJsDocTags(checker));
	}

	private getDeprecationFromNodeHandle(handle: NodeHandle | undefined, project: Project, ast: TypeScriptAstModule): string | null {
		return this.getDeprecationFromDeclaration(handle?.resolve(project), ast);
	}

	private getDeprecationFromJsDocTags(tags: readonly JSDocTagInfo[]): string | null {
		for (const tag of tags) {
			if (tag.name == 'deprecated') return tag.text || DeprecationsScanner.deprecatedMessage;
		}
		return null;
	}

	private getDeprecationFromDeclaration(declaration: Node | undefined, ast: TypeScriptAstModule): string | null {
		if (!declaration) {
			return null;
		}
		for (const tag of ast.getJSDocTags(declaration)) {
			if (tag.tagName.text == 'deprecated') {
				return ast.getTextOfJSDocComment(tag.comment) || DeprecationsScanner.deprecatedMessage;
			}
		}
		return null;
	}

	private isReferenceNode(node: Node, ast: TypeScriptAstModule): boolean {
		return ast.isIdentifier(node) || ast.isPrivateIdentifier(node) || ast.isPropertyAccessExpression(node) || ast.isElementAccessExpression(node);
	}

	private shouldSkipReferenceNode(node: Node, ast: TypeScriptAstModule): boolean {
		const parent = node.parent;
		if (!parent) {
			return true;
		}

		if ((ast.isCallExpression(parent) || ast.isNewExpression(parent)) && parent.expression === node) {
			return true;
		}
		if (ast.isTaggedTemplateExpression(parent) && parent.tag === node) {
			return true;
		}
		if (ast.isPropertyAccessExpression(parent) && parent.name === node) {
			return true;
		}
		if (this.isNamedDeclarationNode(parent, ast) && parent.name === node) {
			return true;
		}
		if (ast.isTypeReferenceNode(parent) || ast.isExpressionWithTypeArguments(parent) || ast.isImportTypeNode(parent) || ast.isTypeQueryNode(parent)) {
			return true;
		}

		return false;
	}

	private isNamedDeclarationNode(node: Node, ast: TypeScriptAstModule): node is NamedNode {
		return ast.isVariableDeclaration(node)
			|| ast.isParameterDeclaration(node)
			|| ast.isFunctionDeclaration(node)
			|| ast.isClassDeclaration(node)
			|| ast.isInterfaceDeclaration(node)
			|| ast.isTypeAliasDeclaration(node)
			|| ast.isEnumDeclaration(node)
			|| ast.isEnumMember(node)
			|| ast.isMethodDeclaration(node)
			|| ast.isMethodSignatureDeclaration(node)
			|| ast.isPropertyDeclaration(node)
			|| ast.isPropertySignatureDeclaration(node)
			|| ast.isGetAccessorDeclaration(node)
			|| ast.isSetAccessorDeclaration(node)
			|| ast.isBindingElement(node)
			|| ast.isImportClause(node)
			|| ast.isImportSpecifier(node)
			|| ast.isNamespaceImport(node)
			|| ast.isImportEqualsDeclaration(node)
			|| ast.isTypeParameterDeclaration(node)
			|| ast.isModuleDeclaration(node);
	}

	private readonly cache = new Map<string, string[]>();
	getLine(file: string, line: number): string {
		if (!this.cache.has(file)) {
			try {
				this.cache.set(file, readFileSync(file, 'utf8').split(/\r?\n/));
			} catch (error) {
				this.cache.set(file, []);
			}
		}
		const lines = this.cache.get(file)!;
		return lines[line - 1] || '';
	}

	private static isIdentifierStart(char: string): boolean {
		return DeprecationsScanner.identifierStartPattern.test(char);
	}

	private static isIdentifierPart(char: string): boolean {
		return DeprecationsScanner.identifierPartPattern.test(char);
	}

	private static getMarkedVisibleEnd(line: string, visibleToRaw: readonly number[], start: number): number {
		const first = line[visibleToRaw[start]];
		if (first === '#' && start + 1 < visibleToRaw.length) {
			let end = start + 1;
			const next = line[visibleToRaw[end]];
			if (DeprecationsScanner.isIdentifierStart(next)) {
				end++;
				while (end < visibleToRaw.length && DeprecationsScanner.isIdentifierPart(line[visibleToRaw[end]])) {
					end++;
				}
				return end;
			}
		}

		if (!DeprecationsScanner.isIdentifierStart(first)) {
			return start + 1;
		}

		let end = start + 1;
		while (end < visibleToRaw.length && DeprecationsScanner.isIdentifierPart(line[visibleToRaw[end]])) {
			end++;
		}
		return end;
	}

	mark(line: string, character: number): string {
		const start = character - 1;
		if (start < 0) {
			return line;
		}

		const visibleToRaw: number[] = [];
		let index = 0;
		while (index < line.length) {
			if (line[index] === '\x1B') {
				DeprecationsScanner.sgrPattern.lastIndex = index;
				const match = DeprecationsScanner.sgrPattern.exec(line);
				if (match && match.index === index) {
					index = DeprecationsScanner.sgrPattern.lastIndex;
					continue;
				}
			}
			visibleToRaw.push(index);
			index++;
		}

		if (start >= visibleToRaw.length) {
			return line;
		}

		const end = DeprecationsScanner.getMarkedVisibleEnd(line, visibleToRaw, start);
		const rawStart = visibleToRaw[start];
		const rawEnd = end < visibleToRaw.length ? visibleToRaw[end] : line.length;
		return `${line.slice(0, rawStart)}\x1B[30;47m${line.slice(rawStart, rawEnd)}\x1B[m${line.slice(rawEnd)}`;
	}
}
