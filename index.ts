/// <reference types="node" />

import { homedir } from 'node:os'
import { createWriteStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { RegisterFunction } from './lib/base'

export default function install(register: RegisterFunction) {
	const downloadsFolder = join(homedir(), 'Downloads')

	register('iosevka', async (_1, arg) => {
		let mirror = 'https://mirrors.tuna.tsinghua.edu.cn'
		let hashfile = mirror + '/github-release/be5invis/Iosevka/LatestRelease/SHA-256.txt'
		if (arg == '--sarasa') {
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
				console.log('Downloading', dest)
				const src = dirname(hashfile) + '/' + name
				const response = await fetch(src)
				if (response.ok && response.body) {
					await pipeline(
						Readable.from(response.body),
						createWriteStream(dest), { end: true }
					)
					console.log('Done.')
				} else {
					console.error(await response.text())
				}
			}
		} else {
			console.error(content)
		}
	}, 'Append --sarasa to download Sarasa')
}
