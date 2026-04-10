import type { Node, TypeChecker, Symbol, Declaration, JSDocComment } from 'typescript';

import { globSync } from 'node:fs';
import { dirname, relative } from 'node:path';

type TypeScriptModule = typeof import('typescript');

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

	private ts: TypeScriptModule | null = null;
	async loadTypeScript(): Promise<TypeScriptModule> {
		if (this.ts) {
			return this.ts;
		}
		try {
			const resolved = require.resolve('typescript', { paths: [this.cwd] });
			this.ts = await import(resolved) as TypeScriptModule;
			console.log(`Loaded TypeScript ${this.ts.version} from current project`);
		} catch (error) {
			this.ts = await import('typescript') as TypeScriptModule;
			console.log(`Using bundled TypeScript ${this.ts.version}`);
		}
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
		const ts = this.ts!;
		const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
		if (configFile.error) {
			console.error(`Failed to read ${configPath}: ${configFile.error.messageText}`);
			return;
		}
		const configParseResult = ts.parseJsonConfigFileContent(configFile.config, ts.sys, this.cwd);
		if (configParseResult.errors.length) {
			console.error(`Failed to parse ${configPath}: ${configParseResult.errors.map(e => e.messageText).join(', ')}`);
			return;
		}
		const program = ts.createProgram({
			rootNames: configParseResult.fileNames,
			options: configParseResult.options
		});
		const checker = program.getTypeChecker();
		const deprecations: Deprecation[] = [];
		const seen = new Set<string>();
		for (const sourceFile of program.getSourceFiles()) {
			if (sourceFile.isDeclarationFile) continue;
			const visit = (node: Node): void => {
				const result = this.getDeprecationAtNode(node, checker, ts);
				if (result) {
					const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, result.location.getStart());
					const deprecation: Deprecation = {
						projectPath: dirname(configPath),
						file: relative(dirname(configPath), sourceFile.fileName),
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
				ts.forEachChild(node, visit);
			};
			visit(sourceFile);
		}
		yield* deprecations;
	}

	private getDeprecationAtNode(node: Node, checker: TypeChecker, ts: TypeScriptModule): { location: Node; message: string; } | null {
		if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
			const signature = checker.getResolvedSignature(node);
			const message = this.getDeprecationFromDeclaration(signature?.declaration, ts);
			if (message) {
				return { location: ts.isTaggedTemplateExpression(node) ? node.tag : node.expression, message };
			}
			return null;
		}

		if (!this.isReferenceNode(node, ts) || this.shouldSkipReferenceNode(node, ts)) {
			return null;
		}

		const symbol = this.getSymbolAtLocation(node, checker, ts);
		const message = symbol ? this.getDeprecationFromSymbol(symbol, ts) : null;
		return message ? { location: node, message } : null;
	}

	private getSymbolAtLocation(node: Node, checker: TypeChecker, ts: TypeScriptModule): Symbol | null {
		const symbol = checker.getSymbolAtLocation(node);
		if (!symbol) {
			return null;
		}
		if (symbol.flags & ts.SymbolFlags.Alias) {
			return checker.getAliasedSymbol(symbol);
		}
		return symbol;
	}

	private getDeprecationFromSymbol(symbol: Symbol, ts: TypeScriptModule): string | null {
		const declarations = symbol.declarations ?? [];
		const declaration = symbol.valueDeclaration ?? declarations[0];
		const message = this.getDeprecationFromDeclaration(declaration, ts);
		if (message) {
			return message;
		}
		if (declarations.length > 1) {
			return null;
		}
		for (const tag of symbol.getJsDocTags()) {
			if (tag.name === 'deprecated') {
				return tag.text ? tag.text.map(part => part.text).join('') : DeprecationsScanner.deprecatedMessage;
			}
		}
		return null;
	}

	private getDeprecationFromDeclaration(declaration: Declaration | undefined, ts: TypeScriptModule): string | null {
		if (!declaration) {
			return null;
		}
		for (const tag of ts.getJSDocTags(declaration)) {
			if (tag.tagName.text === 'deprecated') {
				return this.getJSDocCommentText(tag.comment) || DeprecationsScanner.deprecatedMessage;
			}
		}
		return null;
	}

	private getJSDocCommentText(comment: string | readonly JSDocComment[] | undefined): string {
		if (typeof comment === 'string') {
			return comment;
		}
		if (!comment) {
			return '';
		}
		return comment.map(part => typeof part === 'string' ? part : part.getText()).join('');
	}

	private isReferenceNode(node: Node, ts: TypeScriptModule): boolean {
		return ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
	}

	private shouldSkipReferenceNode(node: Node, ts: TypeScriptModule): boolean {
		const parent = node.parent;
		if (!parent) {
			return true;
		}

		if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) {
			return true;
		}
		if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) {
			return true;
		}
		if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
			return true;
		}
		if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isEnumMember(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isBindingElement(parent) || ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent) || ts.isTypeParameterDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name === node) {
			return true;
		}
		if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent) || ts.isImportTypeNode(parent) || ts.isTypeQueryNode(parent)) {
			return true;
		}

		return false;
	}

	private readonly cache = new Map<string, string[]>();
	getLine(file: string, line: number): string {
		const ts = this.ts!;
		if (!this.cache.has(file)) {
			const content = ts.sys.readFile(file);
			if (content) {
				this.cache.set(file, content.split(/\r?\n/));
			} else {
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
