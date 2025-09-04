/// <reference types="node" />

import { homedir } from 'node:os'
import { createWriteStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'

import spawn from 'nano-spawn'
import { confirm, isCancel } from '@clack/prompts'
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
}
