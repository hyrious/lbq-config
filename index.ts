/// <reference types="node" />

import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

import spawn from 'nano-spawn';
import { hostname, RegisterFunction, showTable, tryUnescape } from './lib/base';
import { taze } from './lib/taze';
import { download, unzip } from './lib/download';

export default function install(register: RegisterFunction) {
	const win32 = process.platform == 'win32'
	const macOS = process.platform == 'darwin'
	const mirror = 'https://mirrors.tuna.tsinghua.edu.cn'

	register('edit', () => {
		spawnSync('subl', ['.'], { cwd: import.meta.dirname, stdio: 'inherit' })
	}, 'Edit ' + import.meta.dirname)

	register('iosevka', async () => {
		const table = await Promise.all(['Iosevka', 'Sarasa-Gothic'].map(async name => {
			let hashfile = `${mirror}/github-release/be5invis/${name}/LatestRelease/SHA-256.txt`
			let content = await fetch(hashfile).then(r => r.text())
			let line = content.split('\n').find(e => e.includes('SuperTTC'))!
			let fileName = line.split(/\s+/)[1]
			let url = dirname(hashfile) + '/' + fileName
			return [name, url]
		}))
		const maxLen = table.reduce((max, a) => Math.max(max, a[0].length), 0)
		for (const row of table) {
			console.log(row[0].padEnd(maxLen), row[1])
		}
	}, 'Print URL to the latest Iosevka & Sarasa')

	if (win32) register('vcvarsall', async () => {
		const vswhere = String.raw`C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe`
		const vsBase = (await spawn(vswhere, ['-latest', '-property', 'installationPath'])).output.trim()
		console.log(join(vsBase, 'vc/Auxiliary/Build/vcvarsall.bat'))
	}, 'Find vcvarsall.bat')

	register('n1', async (_, ...packages) => {
		const tar = await import('tar')
		for (const pkg of packages) {
			const tarball = (await spawn('npm', ['view', pkg, 'dist.tarball'])).output.trim()
			const response = await fetch(tarball)
			if (response.ok && response.body) {
				const dist = join('node_modules', pkg)
				mkdirSync(dist, { recursive: true })
				console.log('Polling', dist)
				await pipeline(
					Readable.from(response.body),
					tar.extract({ strip: 1, cwd: dist }), { end: true }
				)
			} else {
				console.error(response.statusText)
			}
		}
		if (packages.length == 0) console.log('Usage: n1 [packages...]')
	}, 'Manually download a package to node_modules')

	register('update', async () => {
		console.log('Updating...')
		await spawn('git', ['pull', '--ff-only'], { cwd: import.meta.dirname, stdio: 'inherit' })
		await spawn('pnpm', ['install'], { cwd: import.meta.dirname, stdio: 'inherit' })
	}, 'Run git pull in ' + import.meta.dirname)

	register('taze', async (_, ...args) => {
		const { Spinner } = await import('picospinner')
		const s = new Spinner('Running taze...')
		s.start()
		const changes = await taze(args.includes('-g'))
		s.succeed()
		if (changes.length == 0) {
			console.log('No updates.')
			return
		}
		console.log()
		showTable(table => {
			changes.forEach(change => {
				let name = change.name
				let now = change.from.replace(/^[^\d]+/, '')
				let then = change.to.replace(/^[^\d]+/, '')
				let display = [now, win32 ? '->' : '→', then].join(' ')
				table.push([
					{ label: name, link: `https://hyrious.me/npm-browser/?q=${name}` },
					change.compareUrl ? { label: display, link: change.compareUrl } : display,
					{ label: 'diff', link: change.diffUrl }
				])
			})
		})
		console.log()
	}, 'Show package updates and url to the diff page')

	if (win32) register('nodejs', async () => {
		let data = await fetch('https://registry.npmmirror.com/-/binary/node/latest/').then(r => r.json())
		let info = data.findLast((e: { name: string }) => e.name.endsWith('-x64.msi'))
		console.log(info.url)
	}, 'Get latest nodejs download url')

	register('private', async (_, ...args) => {
		const { defineConfig } = await import('@hyrious/lbq')
		const { default: fn } = await import('./private/index')
		const lbq = await defineConfig(fn)

		if (args[0] === '-l' || args[0] === '--list') {
			console.log('Private actions:')
			for (const line of lbq.list()) {
				console.log('  ' + line)
			}
			return
		}

		const actionAndArgs = lbq.find(args)
		if (!actionAndArgs) {
			console.error('No matching action, try --list.')
			process.exitCode = 1
			return
		}

		const [action, matches, restArgs] = actionAndArgs
		try {
			await action.run(...matches, ...restArgs)
		} catch (err) {
			if (err && typeof err === 'object' && typeof err.stack === 'string') {
				const { default: cleanStack } = await import('clean-stack')
				console.error(cleanStack(err.stack))
			} else if (err && typeof err === 'object' && typeof err.message === 'string') {
				console.error(err.message)
			} else {
				console.error(err)
			}
			process.exitCode = 1
		}
	}, 'Pass arguments to private LBQ commands')

	if (win32) register('get', async (_, input) => {
		if (!input.startsWith('https://')) {
			const output = (await spawn('winget', ['show', input, '--source', 'winget'])).stdout
			// WinGet does not provide parsable output [https://github.com/microsoft/winget-cli/issues/1753].
			// So let's search common languages by hand [https://github.com/search?q=repo%3Amicrosoft%2Fwinget-cli+name%3D%22ShowLabelInstallerUrl%22&type=code].
			const ShowLabelInstallerUrl = ['安装程序 URL：', '安裝程式 URL:', 'Installer Url:', 'インストーラーの URL:', '설치 관리자 URL:']
			let prefix = ''
			const line = output.split('\n').find(line => ShowLabelInstallerUrl.some(s => line.trim().startsWith(prefix = s)))
			if (line) {
				input = line.trim().slice(prefix.length).trim()
			} else {
				console.error(output)
				console.error('\n\tCannot find installer URL from winget output.')
				process.exitCode = 1
				return
			}
		}
		const fileName = tryUnescape(basename(input))
		if (input.startsWith('https://github.com')) {
			const [_, user, repo, ...rest] = new URL(input).pathname.split('/')
			const last = rest.pop()!
			const mirrorUrl = `${mirror}/github-release/${user}/${repo}/LatestRelease/${last}`
			const response = await fetch(mirrorUrl, { method: 'HEAD' }).catch(() => [] as unknown as Response)
			if (response.ok) {
				input = mirrorUrl
			}
		}
		const { confirm } = await import('@clack/prompts')
		let ok = await confirm({ message: `Download ${fileName} from ${hostname(input)}?` })
		if (ok === true) {
			const output = join(homedir(), 'Downloads', fileName)
			if (existsSync(output)) {
				console.log(`Exists ${output}, skip download.`)
			} else {
				console.log(`Downloading to ${output}...`)
				await spawn('curl', ['-L', '-o', output, input], { stdio: 'inherit' })
				console.log(`Saved to ${output}.`)
			}
		}
	}, 'Search package from winget and install')

	register('commit', async () => {
		const { text, isCancel } = await import('@clack/prompts')
		const message = await text({ message: 'Commit message:' })
		if (message && !isCancel(message)) {
			const { uniqueNamesGenerator, adjectives, animals } = await import('@joaomoreno/unique-names-generator')
			const dictionaries = [adjectives, animals]
			const branchName = uniqueNamesGenerator({ dictionaries, length: dictionaries.length, separator: '-' })
			await spawn('git', ['switch', '-C', branchName], { stdio: 'inherit' })
			await spawn('git', ['add', '.'], { stdio: 'inherit' })
			await spawn('git', ['commit', '-m', message], { stdio: 'inherit' })
		}
	}, 'Prompt for message, switch to a new branch, then commit')

	register('bun', async () => {
		interface IBinaryEntry {
			readonly name: string
			readonly date: string
			readonly url: string
		}
		let data: IBinaryEntry[] = await fetch('https://registry.npmmirror.com/-/binary/bun').then(r => r.json())
		let maxDate = '', url = ''
		for (const entry of data) {
			if (entry.name.includes('-v') && maxDate < entry.date) {
				maxDate = entry.date
				url = entry.url
			}
		}
		data = await fetch(url).then(r => r.json())
		let hint = macOS ? 'darwin-aarch64.zip' : 'windows-x64.zip'
		let entry = data.find(e => e.name.includes(hint))!
		console.log('.', entry.url)
		let zipfile = await download(entry.url, join(homedir(), 'Downloads'))
		let outdir = tmpdir()
		await unzip(zipfile, outdir)
		let outfile = join(outdir, macOS ? 'bun-darwin-aarch64' : 'bun-windows-x64', win32 ? 'bun.exe' : 'bun')
		if (existsSync(outfile)) {
			renameSync(outfile, join(homedir(), '.bun', 'bin', win32 ? 'bun.exe' : 'bun'))
			console.log('Done.')
		} else {
			console.error('Not found', outfile)
		}
	}, 'Upgrade bun')
}
