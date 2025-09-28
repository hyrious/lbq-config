/// <reference types="node" />

import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import spawn from 'nano-spawn';
import { hostname, RegisterFunction, tryUnescape } from './lib/base';

export default function install(register: RegisterFunction) {
	const win32 = process.platform == 'win32'
	const mirror = 'https://mirrors.tuna.tsinghua.edu.cn'

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
		const { CheckPackages, resolvePackage } = await import('taze')
		if (args.includes('-g')) {
			const stdout = (await spawn('npm', ['ls', '--global', '--depth=0', '--json'])).output.trim()
			const json = JSON.parse(stdout) as { dependencies: { [x: string]: { version: string } | undefined } }
			const pkgs = Object.entries(json.dependencies).filter(a => a[1]?.version)
			const pkg: import('taze').PackageMeta = {
				agent: 'npm',
				private: true,
				type: 'global',
				resolved: [],
				raw: null,
				version: '',
				filepath: '',
				relative: '',
				deps: pkgs.map(([name, i]) => ({
					name,
					currentVersion: `^${i?.version}`,
					update: true,
					source: 'dependencies'
				})),
				name: 'npm (global)'
			}
			await resolvePackage(pkg, {
				mode: 'latest',
				loglevel: 'error',
				maturityPeriod: 2,
				includeLocked: true
			}, () => true)
			show(pkg.resolved.filter(i => i.update))
		} else {
			await CheckPackages({
				mode: 'latest',
				loglevel: 'error',
				maturityPeriod: 2,
				includeLocked: true
			}, {
				afterPackageEnd(pkg) {
					show(pkg.resolved.filter(i => i.update))
				}
			})
		}
		function show(changes: import('taze').ResolvedDepChange[]) {
			if (changes.length == 0) {
				console.log('No updates.')
				return
			}
			console.log()
			let maxLen = changes.reduce((max, c) => Math.max(max, c.name.length), 0)
			changes.forEach(change => {
				let name = change.name
				let now = change.currentVersion.replace(/^[^\d]+/, '')
				let then = change.targetVersion.replace(/^[^\d]+/, '')
				let a = `${name}@${now}`, b = `${name}@${then}`
				let link = [now, win32 ? '→ ' : '→', then].join(' ')
				let url = `https://hyrious.me/npm-diff/?a=${a}&b=${b}`
				console.log(`  ${name.padEnd(maxLen)}  \x1b]8;;${url}\x07${link}\x1b]8;;\x07`)
			})
			console.log()
		}
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
			const mirror = `https://mirrors.tuna.tsinghua.edu.cn/github-release/${user}/${repo}/LatestRelease/${last}`
			const response = await fetch(mirror, { method: 'HEAD' }).catch(() => [] as unknown as Response)
			if (response.ok) {
				input = mirror
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
}
