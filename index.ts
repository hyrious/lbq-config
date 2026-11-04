import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import tildify from 'tildify';
import { bool, confirm, editFile, exec, execOrFail, readJson, str, writeJson } from './lib/base';
import { DeprecationsScanner, ProgressLine } from './lib/scanDeprecations';

export default function install(register: RegisterFunction) {
	const win32 = process.platform == 'win32'
	const macOS = process.platform == 'darwin'
	const dataPath = join(import.meta.dirname, 'data')

	register('update', () => {
		console.log('Updating...')
		execOrFail('git', ['pull', '--ff-only'], { cwd: import.meta.dirname, stdio: 'inherit' })
		execOrFail('npm', ['install'], { cwd: import.meta.dirname, stdio: 'inherit' })
	}, 'Pull latest lbq config')

	if (macOS) register('dock', async () => {
		const { runJxa } = await import('run-jxa')
		// screen.frame = full window, screen.visibleFrame = frame - appbar - dock
		await runJxa(`
			ObjC.import('AppKit')
			const screen = $.NSScreen.screens.objectAtIndex(0)
			const frame = screen.visibleFrame
			Application('iTerm2').currentWindow.bounds = {
				x: frame.origin.x + frame.size.width - 710,
				y: screen.frame.size.height - frame.origin.y - 455,
				width: 710,
				height: 455,
			}
		`)
	}, 'Move iTerm2.app to bottom right')

	register('note', (_, ...args) => {
		const edit = bool(args, ['-e', '--edit'])
		const notesPath = join(dataPath, 'notes.json')
		const notes = readJson<{ [path: string]: string | string[] | undefined }>(notesPath, {})
		const key = tildify(process.cwd())
		if (edit || notes[key] == null) {
			notes[key] ||= 'Hello, world!'
			writeJson(notesPath, notes)
			return editFile(notesPath)
		}
		puts(notes[key])
		function puts(str: string | readonly string[]) {
			typeof str == 'string' ? console.log(highlight(str)) : str.forEach(puts)
		}
		function highlight(str: string) {
			if (!str.startsWith('$ ')) return str;
			let index = 0
			return '$ ' + str.slice(2).replace(/#[^\r\n]*|(?:[^\s'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g, token => {
				let color = ''
				if (token.startsWith('#')) color = '90';
				else {
					const position = index++
					if (position == 0) color = '1;32';
					else if (/^--?[a-zA-Z]/.test(token)) color = '36';
					else if (position == 1 && /^[a-zA-Z]+$/.test(token)) color = '32';
				}
				const highlighted = color == '90'
					? token.replace(/\[[^\]\r\n]*\]|<\w+>|\{\w+\}/g, word => {
						return word[0] == '['
							? `\x1B[m${placeholders(word, '')}\x1B[90m`
							: placeholders(word, color)
					})
					: placeholders(token, color)
				return color ? `\x1B[${color}m${highlighted}\x1B[m` : highlighted
			})
			function placeholders(text: string, color: string) {
				return text.replace(/<\w+>|\{\w+\}/g, word => {
					return `\x1B[0;${word[0] == '<' ? '33' : '35'}m${word}\x1B[m\x1B[${color}m`
				})
			}
		}
	}, 'Local notebook, --edit to edit it')

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

		for (const path of releases) {
			rmSync(path, { recursive: true, force: true })
			console.log('Deleted daemon', tildify(path))
		}

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
