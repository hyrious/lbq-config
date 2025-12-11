import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface IBrokenNodeModule {
	readonly name: string; // 'pkg'
	readonly garbage: string; // 'path/to/.pkg-1a2b3c4d'
}

const NODE_MODULES = 'node_modules'

function safeReaddir(dir: string): string[] {
	try { return readdirSync(dir) }
	catch { return [] }
}

export function scanBrokenNodeModules(base: string = '.', result: IBrokenNodeModule[] = []): IBrokenNodeModule[] {
	const names = safeReaddir(join(base, NODE_MODULES))
	for (const name of names) {
		if (name[0] == '@') {
			const scopedNames = safeReaddir(join(base, NODE_MODULES, name))
			for (const scopedName of scopedNames) {
				if (scopedName[0] != '.') {
					let garbage = scopedNames.find(e => e.startsWith(`.${scopedName}-`))
					if (garbage) {
						result.push({
							name: join(name, scopedName),
							garbage: join(base, NODE_MODULES, name, garbage)
						})
					}
					scanBrokenNodeModules(join(base, NODE_MODULES, name, scopedName), result)
				}
			}
		} else if (name[0] != '.') {
			let garbage = names.find(e => e.startsWith(`.${name}-`))
			if (garbage) {
				result.push({
					name,
					garbage: join(base, NODE_MODULES, garbage)
				})
			}
			scanBrokenNodeModules(join(base, NODE_MODULES, name), result)
		}
	}
	return result
}
