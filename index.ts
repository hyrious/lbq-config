/// <reference types="node" />

import { homedir } from 'node:os'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'

import spawn from 'nano-spawn'
import { confirm } from '@clack/prompts'
import { RegisterFunction } from './lib/base'

export default function install(register: RegisterFunction) {
	const win32 = process.platform == 'win32'
	const macOS = process.platform == 'darwin'
	const downloadsFolder = join(homedir(), 'Downloads')

	register('iosevka', async (_1, ...args) => {
		let mirror = 'https://mirrors.tuna.tsinghua.edu.cn'
		let hashfile = mirror + '/github-release/be5invis/Iosevka/LatestRelease/SHA-256.txt'
		if (args.includes('--sarasa')) {
			hashfile = mirror + '/github-release/be5invis/Sarasa-Gothic/LatestRelease/SHA-256.txt'
		}
		let content = await fetch(hashfile).then(r => r.text())
		let line = content.split('\n').find(e => e.includes('SuperTTC'))
		if (line) {
			const [_, name] = line.split(/\s+/)
			const dest = join(downloadsFolder, name)
			if (existsSync(dest)) {
				console.log(dest, 'already exists')
			} else {
				let out = await confirm({ message: `Download ${name}?` })
				if (out == true) {
					console.log('Downloading', dest)
					const src = dirname(hashfile) + '/' + name
					const response = await fetch(src)
					if (response.ok && response.body) {
						await pipeline(
							Readable.from(response.body),
							createWriteStream(dest), { end: true }
						)
						console.log('Done.')
						if (macOS) console.log('Hint: Copy the TTC file to ~/Library/Fonts to finish installation.')
					} else {
						console.error(await response.text())
					}
				}
			}
		} else {
			console.error(content)
		}
	}, 'Append --sarasa to download Sarasa')

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
			pkg.resolved.filter(i => i.update).forEach(change => {
				let name = change.name
				let now = change.currentVersion.replace(/^[^\d]+/, '')
				let then = change.targetVersion.replace(/^[^\d]+/, '')
				let a = `${name}@${now}`, b = `${name}@${then}`
				console.log(change.name, now, '→ ', then, `https://hyrious.me/npm-diff/?a=${a}&b=${b}`)
			})
		} else {
			await CheckPackages({
				mode: 'latest',
				loglevel: 'error',
				maturityPeriod: 2,
				includeLocked: true
			}, {
				afterPackageEnd(pkg) {
					pkg.resolved.filter(i => i.update).forEach(change => {
						let name = change.name
						let now = change.currentVersion.replace(/^[^\d]+/, '')
						let then = change.targetVersion.replace(/^[^\d]+/, '')
						let a = `${name}@${now}`, b = `${name}@${then}`
						console.log(change.name, now, '→ ', then, `https://hyrious.me/npm-diff/?a=${a}&b=${b}`)
					})
				}
			})
		}
	}, 'Show package updates and url to the diff page')

	if (win32) register('nodejs', async () => {
		let data = await fetch('https://registry.npmmirror.com/-/binary/node/latest/').then(r => r.json())
		let info = data.findLast((e: { name: string }) => e.name.endsWith('-x64.msi'))
		console.log(info.url)
	}, 'Get latest nodejs download url')
}
