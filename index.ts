import { execFileSync, execSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import tildify from 'tildify';
import { bool, confirm, editFile, exec, execOrFail, readJson, str, truncate, writeJson } from './lib/base';
import { DeprecationsScanner, ProgressLine } from './lib/scanDeprecations';

export default function install(register: RegisterFunction) {
	const win32 = process.platform == 'win32'
	const macOS = process.platform == 'darwin'

	register('update', () => {
		console.log('Updating...')
		execOrFail('git', ['pull', '--ff-only'], { cwd: import.meta.dirname, stdio: 'inherit' })
		execOrFail('npm', ['install'], { cwd: import.meta.dirname, stdio: 'inherit' })
	}, 'Pull latest lbq config')

	register('codex', async (_, ...args) => {
		const configDir = join(homedir(), '.codex')
		const configPath = join(configDir, 'config.toml')
		const target = exec('git', ['rev-parse', '--show-toplevel']) || process.cwd()
		const custom = rewriteCodexProjects(configPath, target)

		if (!args.includes('--yolo')) args.unshift('--yolo');
		const env = { HTTPS_PROXY: '', RUST_LOG: 'warn', ...process.env }
		if (!custom) env.HTTPS_PROXY = 'http://localhost:7890';

		try {
			execFileSync('codex', args, { stdio: 'inherit', env })
		} catch (e) {
			if (e.status) process.exitCode = e.status;
			else throw e
		}

		function rewriteCodexProjects(configPath: string, target: string): boolean {
			const source = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n')
			const lines = source.split('\n')
			const kept: string[] = []
			let skipping = false
			for (const line of lines) {
				if (/^\s*\[projects(?:\..+)?\]\s*$/.test(line)) {
					skipping = true
					continue
				}
				if (skipping && /^\s*\[.+\]\s*$/.test(line)) {
					skipping = false
				}
				if (!skipping) kept.push(line)
			}
			const content = kept.join('\n').trimEnd()
			const pathLiteral = JSON.stringify(target)
			const projectBlock = `[projects.${pathLiteral}]\ntrust_level = "trusted"\n`
			writeFileSync(configPath, `${content}\n\n${projectBlock}`)
			return source.includes('model_provider = ')
		}
	}, 'Trust current repo, then run codex --yolo')

	register('codex', 'clean', async () => {
		exec('lbq', ['codex', 'app-server', 'daemon', 'stop'], { stdio: 'inherit' })
		const codexHome = join(homedir(), '.codex')
		const before = execOrFail('du', ['-sh', codexHome]).split('\t')[0]
		const result = execOrFail('sqlite3', ['-readonly', join(codexHome, 'state_5.sqlite'), 'SELECT id FROM threads;'])
		const uuidre = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		const sessions = result.trimEnd().split(/\r?\n/g).filter(e => uuidre.test(e))

		const daemon = join(codexHome, 'packages', 'app-server-daemon')
		const current = readlinkSync(join(daemon, 'current'))
		const releases = readdirSync(join(daemon, 'releases')).map(e => join(daemon, 'releases', e)).filter(e => e != current)

		if (!sessions.length && !releases.length) {
			console.log('Nothing to clean.')
			return
		}

		if (!await confirm(`Delete ${sessions.length} sessions and ${releases.length} daemons?`)) return;

		for (const session of sessions) {
			exec('codex', ['delete', '--force', session], { stdio: 'inherit' })
		}

		releases.forEach((path) => {
			rmSync(path, { recursive: true, force: true })
			console.log('Deleted daemon', tildify(path))
		})

		exec('lbq', ['codex', 'app-server', 'daemon', 'start'])
		const after = execOrFail('du', ['-sh', codexHome]).split('\t')[0]
		console.log(`Done. ~/.codex: ${before} -> ${after}`)
	}, 'Delete codex sessions and stale app-server daemon')

	register('gswc', async () => {
		const { uniqueNamesGenerator, adjectives, animals } = await import('@joaomoreno/unique-names-generator')
		const dictionaries = [adjectives, animals]
		const branchName = uniqueNamesGenerator({ dictionaries, length: dictionaries.length, separator: '-' })
		execOrFail('git', ['switch', '-C', branchName], { stdio: 'inherit' })
	}, 'Switch to a random branch')

	if (macOS) register('chrome', async (_, ...args) => {
		const test = bool(args, ['-t', '--test'])
		const test2 = bool(args, ['-tt', '--test2'])
		const yolo = bool(args, ['--yolo', '--danger'])
		const debug = bool(args, ['-d', '--debug', '--debugger'])
		const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
		const chromeArgs: string[] = ['--disable-fre', '--no-first-run', '--window-size=1152,720']
		if (test || test2) chromeArgs.push('--user-data-dir=/tmp/test-chrome-profile-dir' + (test2 ? '2' : ''));
		if (yolo) chromeArgs.push('--disable-web-security');
		if (debug) chromeArgs.push('--remote-debugging-port=9222')
		execOrFail(chrome, chromeArgs, { stdio: 'inherit' })
	}, 'Open chrome, [-t|-tt|-d|--yolo]')

	register('ci', async (_, ...args) => {
		const all = bool(args, '--all')
		const print = bool(args, ['--print', '-p'])
		const edit = bool(args, '--edit')
		const gen = bool(args, '--gen')
		if (args.length) {
			console.log('Usage: lbq ci [--all|--print|-p|--edit|--gen]')
			return
		}

		const configPath = fileURLToPath(new URL('./data/ci.json', import.meta.url))
		const config: Record<string, string[]> = readJson(configPath, {})
		const cwd = process.cwd()
		const key = tildify(cwd)
		const commands = config[key] || []

		if (edit) {
			if (!Object.hasOwn(config, key)) {
				config[key] = []
				writeJson(configPath, config)
			}
			editFile(configPath)
			return
		}

		if (gen) {
			const prompt = [
				`Inspect the current directory using read-only tools and propose lightweight local CI checks for daily development.`,
				`Read project scripts, CI workflows, and documentation. Use existing tooling. Do not execute commands or modify files.`,
				`Choose a small, useful sequence of checks such as lint, formatting checks, type checks, and fast tests. Return multiple commands when appropriate, without redundant checks.`,
				`Avoid full builds, lengthy test suites, integration tests requiring external services, deployments, publishing, destructive cleanup, and automatic fixes. Inspect what scripts actually run before choosing them.`,
				`Return only a JSON array of shell command strings in execution order. If no suitable checks can be found, return [].`,
				`Each command runs in a separate shell in ${JSON.stringify(cwd)} on ${process.platform}; shell state does not carry over between commands. Execution stops on the first failure.`,
				`Existing commands (verify against the project; these may be incorrect): ${JSON.stringify(commands)}`
			].join('\n');
			console.log('Generating CI commands...')
			const output = execOrFail('pi', ['--no-session', '--no-extensions', '--no-mcp', '--tools', 'read,grep,find,ls', '-p', prompt])
			const generated: unknown = JSON.parse(output.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'))
			if (!Array.isArray(generated) || !generated.every(command => typeof command == 'string' && command.trim())) {
				throw new Error('Expected a JSON array of non-empty shell commands.')
			}
			if (!generated.length) {
				console.log('No suitable CI checks found. Existing commands were not changed.')
				return
			}
			config[key] = generated
			writeJson(configPath, config)
			printCommands(generated)
			return
		}

		if (all) {
			for (const [path, commands] of Object.entries(config)) {
				console.log(styleText(['bold', 'cyan'], path))
				printCommands(commands)
			}
		} else if (commands.length) {
			if (print) {
				printCommands(commands)
				return
			}
			const times: string[] = []
			const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
			try {
				for (const command of commands) {
					console.log(styleText('underline', command))
					const start = performance.now()
					try {
						execSync(command, { cwd, stdio: 'inherit' })
					} finally {
						times.push(format.format((performance.now() - start) / 1000) + 's')
					}
				}
			} finally {
				const width = Math.max(4, ...times.map(time => time.length))
				const limit = Math.max(1, (process.stdout.columns || 100) - width - 2)
				for (const [index, time] of times.entries()) {
					const command = commands[index].replace(/\r?\n/g, ' ')
					console.log(`${time.padStart(width)}  ${truncate(command, limit)}`)
				}
				console.log()
			}
		} else {
			console.log('No CI commands configured. Use lbq ci --gen or lbq ci --edit.')
		}

		function printCommands(commands: string[]) {
			for (const command of commands) {
				console.log(`  ${styleText('dim', command)}`)
			}
		}
	}, 'Local CI')

	register('deprecate', async (_, ...args) => {
		const silent = bool(args, ['-s', '--silent'])
		const exclude = str(args, '--exclude') ?? null
		const scanner = new DeprecationsScanner(process.cwd(), args, exclude)
		const { highlight } = await import('@babel/code-frame')
		const progress = new ProgressLine(process.stderr)
		try {
			for await (const result of scanner.scanFiles(silent)) {
				const percent = result.total == 0 ? '100.0' : (result.scanned / result.total * 100).toFixed(1)
				progress.render(`Scanned ${result.scanned}/${result.total} files (${percent}%)`)
				if (result.file.startsWith('..') || !result.deprecations.length) continue
				const deprecations = result.deprecations.toSorted((a, b) => a.line - b.line || a.character - b.character).filter((dep, index, self) => {
					return index == 0 || dep.line != self[index - 1].line
				})
				let output = `\x1B[35m${result.file}\x1B[m\n`
				for (const { line, character, message, projectPath } of deprecations) {
					const highlighted = highlight(scanner.getLine(join(projectPath, result.file), line))
					output += `\x1B[32m${line}\x1B[m: ${scanner.mark(highlighted, character)} \x1B[2m// ${message}\x1B[m\n`
				}
				output += '\n'
				progress.writeStdout(output)
			}
		} finally {
			progress.done()
		}
	}, 'Scan deprecations, [-s|--exclude <pattern>] [paths]')
}
