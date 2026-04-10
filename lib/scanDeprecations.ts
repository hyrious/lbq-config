import { globSync } from 'node:fs';
import { dirname, relative } from 'node:path';

type TypeScriptModule = typeof import('typescript');

export interface Deprecation {
	readonly file: string;
	readonly line: number; // 1-based
	readonly character: number; // 1-based
	readonly message: string;
}

export class DeprecationsScanner {
	constructor(readonly cwd: string = process.cwd()) { }

	private ts: TypeScriptModule | null = null;
	async loadTypeScript(): Promise<TypeScriptModule> {
		if (this.ts) {
			return this.ts;
		}
		try {
			this.ts = await import(require.resolve('typescript', { paths: [this.cwd] })) as TypeScriptModule;
		} catch (error) {
			this.ts = await import('typescript') as TypeScriptModule;
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

	async *scanProject(projectPath: string): AsyncIterable<Deprecation> {
		const ts = this.ts!;
		const configFile = ts.readConfigFile(projectPath, ts.sys.readFile);
		if (configFile.error) {
			console.error(`Failed to read ${projectPath}: ${configFile.error.messageText}`);
			return;
		}
		const configParseResult = ts.parseJsonConfigFileContent(configFile.config, ts.sys, this.cwd);
		if (configParseResult.errors.length) {
			console.error(`Failed to parse ${projectPath}: ${configParseResult.errors.map(e => e.messageText).join(', ')}`);
			return;
		}
		const program = ts.createProgram({
			rootNames: configParseResult.fileNames,
			options: configParseResult.options
		});
		const checker = program.getTypeChecker();
		const deprecations: Deprecation[] = [];
		for (const sourceFile of program.getSourceFiles()) {
			if (sourceFile.isDeclarationFile) continue;
			ts.forEachChild(sourceFile, function visit(node) {
				const symbol = checker.getSymbolAtLocation(node);
				if (symbol) {
					const jsDocTags = symbol.getJsDocTags();
					for (const tag of jsDocTags) {
						if (tag.name === 'deprecated') {
							const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart());
							const deprecation: Deprecation = {
								file: relative(dirname(projectPath), sourceFile.fileName),
								line: line + 1,
								character: character + 1,
								message: tag.text ? tag.text.map(t => t.text).join(' ') : 'Deprecated API'
							};
							deprecations.push(deprecation);
						}
					}
				}
				ts.forEachChild(node, visit);
			});
		}
		yield* deprecations;
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
}
