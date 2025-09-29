import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as stream from 'node:stream'
import * as streamWeb from 'node:stream/web'
import { spawnSync } from 'node:child_process';
import { tryUnescape } from './base';

declare global {
	interface Response {
		body: streamWeb.ReadableStream<Uint8Array> | null
	}
}

export async function download(url: string, outdir: string): Promise<string> {
	const tmpdir = await fsp.mkdtemp('lbq-')
	const file = tryUnescape(path.basename(url))
	try {
		const response = await fetch(url)
		if (response.ok && response.body) {
			await stream.promises.pipeline(
				stream.Readable.fromWeb(response.body),
				fs.createWriteStream(path.join(tmpdir, file)), { end: true }
			)
			await fsp.rename(path.join(tmpdir, file), path.join(outdir, file))
			return path.join(outdir, file)
		}
		throw new Error(await response.text())
	} finally {
		await fsp.rm(tmpdir, { recursive: true, force: true })
	}
}

export async function unzip(file: string, outdir: string): Promise<void> {
	if (process.platform === 'win32') {
		const { default: yauzl } = await import('yauzl')
		await new Promise((resolve, reject) => {
			yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
				if (err) return reject(err);
				zipfile.on('entry', entry => {
					if (entry.fileName.endsWith('/')) {
						zipfile.readEntry()
					} else {
						// No symlink support.
						zipfile.openReadStream(entry, (err, istream) => {
							if (err) return reject(err);
							const filePath = path.join(outdir, entry.fileName)
							console.log('.', filePath)
							fs.mkdirSync(path.dirname(filePath), { recursive: true })
							const ostream = fs.createWriteStream(filePath)
							ostream.on('finish', () => zipfile.readEntry())
							istream.on('error', reject)
							istream.pipe(ostream)
						})
					}
				})
				zipfile.on('close', resolve)
				zipfile.readEntry()
			})
		})
	} else {
		spawnSync('unzip', [file, '-d', outdir], { stdio: 'inherit' })
	}
}
