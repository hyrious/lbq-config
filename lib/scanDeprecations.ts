import type { Diagnostic, Project } from 'typescript/unstable/sync';
import type { Node } from 'typescript/unstable/ast';

import { globSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type TypeScriptVersionModule = typeof import('typescript');
type TypeScriptSyncModule = typeof import('typescript/unstable/sync');
type TypeScriptAstModule = typeof import('typescript/unstable/ast');

interface TypeScriptModules {
	readonly version: TypeScriptVersionModule;
	readonly sync: TypeScriptSyncModule;
	readonly ast: TypeScriptAstModule;
}

export interface Deprecation {
	readonly projectPath: string;
	readonly file: string;
	readonly line: number; // 1-based
	readonly character: number; // 1-based
	readonly message: string;
}

export interface DeprecationFileResult {
	readonly projectPath: string;
	readonly file: string;
	readonly scanned: number;
	readonly total: number;
	readonly deprecations: readonly Deprecation[];
}

interface WorkerRequest {
	readonly cwd: string;
	readonly configPath: string;
	readonly files: readonly string[];
}

interface WorkerFileResult {
	readonly projectPath: string;
	readonly file: string;
	readonly deprecations: readonly Deprecation[];
}

interface WorkerResultMessage {
	readonly kind: 'result';
	readonly result: WorkerFileResult;
}

interface WorkerErrorMessage {
	readonly kind: 'error';
	readonly message: string;
}

type WorkerMessage = WorkerResultMessage | WorkerErrorMessage;

export class DeprecationsScanner {
	readonly cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
	}

	private static readonly deprecatedMessage = 'Deprecated API';
	static readonly workerFlag = '--scan-deprecations-worker';
	private static readonly sgrPattern = /\x1B\[[0-9;]*m/g;
	private static readonly identifierStartPattern = /[$_\p{ID_Start}]/u;
	private static readonly identifierPartPattern = /[$_\u200C\u200D\p{ID_Continue}]/u;
	private static readonly sourceFilePattern = /\.[cm]?[jt]sx?$/;
	private static readonly declarationFilePattern = /\.d\.[cm]?ts$/;
	private static readonly defaultBatchSize = 100;

	private ts: TypeScriptModules | null = null;
	async loadTypeScript(silent = false): Promise<TypeScriptModules> {
		if (this.ts) {
			return this.ts;
		}
		this.ts = {
			version: await import('typescript') as TypeScriptVersionModule,
			sync: await import('typescript/unstable/sync') as TypeScriptSyncModule,
			ast: await import('typescript/unstable/ast') as TypeScriptAstModule
		};
		if (!silent) {
			console.error(`Using bundled TypeScript ${this.ts.version.version}`);
		}
		return this.ts;
	}

	async *scan(silent = false): AsyncIterable<Deprecation> {
		for await (const result of this.scanFiles(silent)) {
			yield* result.deprecations;
		}
	}

	async *scanFiles(silent = false, batchSize = DeprecationsScanner.defaultBatchSize): AsyncIterable<DeprecationFileResult> {
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
			yield* this.scanProjectFiles(project, batchSize);
		}
	}

	async *scanProject(configPath: string): AsyncIterable<Deprecation> {
		for await (const result of this.scanProjectFiles(configPath)) {
			yield* result.deprecations;
		}
	}

	async *scanProjectFiles(configPath: string, batchSize = DeprecationsScanner.defaultBatchSize): AsyncIterable<DeprecationFileResult> {
		const ts = await this.loadTypeScript();
		const files = this.getProjectSourceFiles(configPath, ts);
		const total = files.length;
		let scanned = 0;

		for (let index = 0; index < files.length; index += batchSize) {
			const batch = files.slice(index, index + batchSize);
			for await (const result of this.scanWorkerBatch({ cwd: this.cwd, configPath, files: batch })) {
				scanned++;
				yield { ...result, scanned, total };
			}
		}
	}

	private getProjectSourceFiles(configPath: string, ts: TypeScriptModules): readonly string[] {
		const api = new ts.sync.API({ cwd: this.cwd });
		try {
			return api.parseConfigFile(configPath).fileNames.filter(fileName => {
				return DeprecationsScanner.sourceFilePattern.test(fileName) && !DeprecationsScanner.declarationFilePattern.test(fileName);
			});
		} catch (error) {
			console.error(`Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		} finally {
			api.close();
		}
	}

	private async *scanWorkerBatch(request: WorkerRequest): AsyncIterable<WorkerFileResult> {
		const workerPath = fileURLToPath(import.meta.url);
		const worker = spawn(process.execPath, [...DeprecationsScanner.getWorkerExecArgv(), workerPath, DeprecationsScanner.workerFlag], {
			cwd: this.cwd,
			stdio: ['pipe', 'pipe', 'inherit']
		});
		let failed = false;
		const exit = new Promise<number | null>((resolveExit, rejectExit) => {
			worker.once('error', rejectExit);
			worker.once('close', resolveExit);
		});
		worker.stdin.end(JSON.stringify(request));

		const lines = createInterface({ input: worker.stdout });
		for await (const line of lines) {
			if (!line) {
				continue;
			}
			const message = JSON.parse(line) as WorkerMessage;
			if (message.kind == 'result') {
				yield message.result;
			} else {
				failed = true;
				console.error(message.message);
			}
		}

		const exitCode = await exit;
		if (exitCode != 0 && !failed) {
			console.error(`Deprecation worker exited with code ${exitCode}.`);
		}
	}

	private static getWorkerExecArgv(): string[] {
		const args: string[] = [];
		let skipNext = false;
		for (const arg of process.execArgv) {
			if (skipNext) {
				skipNext = false;
				continue;
			}
			if (arg == '--input-type') {
				skipNext = true;
				continue;
			}
			if (arg.startsWith('--input-type=')) {
				continue;
			}
			args.push(arg);
		}
		return args;
	}

	private async scanBatchInCurrentProcess(request: WorkerRequest): Promise<readonly WorkerFileResult[]> {
		const ts = await this.loadTypeScript(true);
		const api = new ts.sync.API({ cwd: request.cwd });
		const projectPath = resolve(this.cwd, dirname(request.configPath));
		let snapshot: InstanceType<TypeScriptSyncModule['Snapshot']> | null = null;
		try {
			snapshot = api.updateSnapshot({ openProjects: [request.configPath], openFiles: [...request.files] });
		} catch (error) {
			console.error(`Failed to load ${request.configPath}: ${error instanceof Error ? error.message : String(error)}`);
			api.close();
			return [];
		}

		try {
			const project = snapshot.getProject(request.configPath) ?? snapshot.getProjects()[0];
			if (!project) {
				console.error(`Failed to load ${request.configPath}: no TypeScript project was created.`);
				return [];
			}
			const configErrors = project.program.getConfigFileParsingDiagnostics();
			if (configErrors.length) {
				console.error(`Failed to parse ${request.configPath}: ${configErrors.map(e => e.text).join(', ')}`);
				return [];
			}
			return request.files.map(fileName => this.scanFile(project, fileName, projectPath, ts));
		} finally {
			snapshot.dispose();
			api.close();
		}
	}

	private scanFile(project: Project, fileName: string, projectPath: string, ts: TypeScriptModules): WorkerFileResult {
		const sourceFile = project.program.getSourceFile(fileName);
		if (!sourceFile || sourceFile.isDeclarationFile) {
			return {
				projectPath,
				file: relative(projectPath, fileName),
				deprecations: []
			};
		}

		const seen = new Set<string>();
		const deprecations: Deprecation[] = [];
		for (const diagnostic of project.program.getSuggestionDiagnostics(fileName)) {
			if (!diagnostic.reportsDeprecated) {
				continue;
			}
			const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.pos);
			const deprecation: Deprecation = {
				projectPath,
				file: relative(projectPath, sourceFile.fileName),
				line: position.line + 1,
				character: position.character + 1,
				message: this.getDiagnosticMessage(diagnostic, project, ts).replaceAll(/\s+/g, ' ').trim()
			};
			const key = `${deprecation.file}:${deprecation.line}:${deprecation.character}:${deprecation.message}`;
			if (!seen.has(key)) {
				seen.add(key);
				deprecations.push(deprecation);
			}
		}
		return {
			projectPath,
			file: relative(projectPath, sourceFile.fileName),
			deprecations
		};
	}

	private getDiagnosticMessage(diagnostic: Diagnostic, project: Project, ts: TypeScriptModules): string {
		for (const related of diagnostic.relatedInformation ?? []) {
			if (!related.fileName) {
				continue;
			}
			const sourceFile = project.program.getSourceFile(related.fileName);
			if (!sourceFile) {
				continue;
			}
			const message = this.getDeprecatedMessageAtPosition(sourceFile, related.pos, related.end, ts.ast);
			if (message) {
				return message;
			}
		}
		return diagnostic.text || DeprecationsScanner.deprecatedMessage;
	}

	private getDeprecatedMessageAtPosition(sourceFile: Node, pos: number, end: number, ast: TypeScriptAstModule): string | null {
		let message: string | null = null;
		const visit = (node: Node): void => {
			if (node.getFullStart() > pos || node.end < end) {
				return;
			}
			for (const tag of ast.getJSDocTags(node)) {
				if (tag.tagName.text == 'deprecated') {
					message = ast.getTextOfJSDocComment(tag.comment) || DeprecationsScanner.deprecatedMessage;
				}
			}
			node.forEachChild(visit);
		};
		visit(sourceFile);
		return message;
	}

	static async runWorker(): Promise<void> {
		const input = await DeprecationsScanner.readStdin();
		const request = JSON.parse(input) as WorkerRequest;
		const scanner = new DeprecationsScanner(request.cwd);
		const results = await scanner.scanBatchInCurrentProcess(request);
		for (const result of results) {
			const message: WorkerResultMessage = { kind: 'result', result };
			process.stdout.write(`${JSON.stringify(message)}\n`);
		}
	}

	private static async readStdin(): Promise<string> {
		let input = '';
		process.stdin.setEncoding('utf8');
		for await (const chunk of process.stdin) {
			input += chunk;
		}
		return input;
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

if (process.argv[2] == DeprecationsScanner.workerFlag && resolve(process.argv[1] || '') == fileURLToPath(import.meta.url)) {
	DeprecationsScanner.runWorker().catch(error => {
		const message: WorkerErrorMessage = {
			kind: 'error',
			message: error instanceof Error ? error.stack || error.message : String(error)
		};
		process.stdout.write(`${JSON.stringify(message)}\n`);
		process.exitCode = 1;
	});
}
