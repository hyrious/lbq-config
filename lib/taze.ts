import spawn from 'nano-spawn'
import { cleanVersion } from './base';

export interface TazeOutputEntry {
	readonly name: string
	readonly from: string
	readonly to: string
	readonly diffUrl: string
	readonly compareUrl: string | undefined
}

export async function taze(checkGlobal?: boolean): Promise<readonly TazeOutputEntry[]> {
	const { CheckPackages, resolvePackage } = await import('taze')
	let data: import('taze').ResolvedDepChange[] = []
	if (checkGlobal) {
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
		data = pkg.resolved.filter(i => i.update)
	} else {
		await CheckPackages({
			mode: 'latest',
			loglevel: 'error',
			maturityPeriod: 2,
			includeLocked: true
		}, {
			afterPackageEnd(pkg) {
				data = pkg.resolved.filter(i => i.update)
			}
		})
	}
	const out: TazeOutputEntry[] = [];
	const compares = await Promise.all(data.map(a => spawn('npx', ['@hyrious/npm-repo', a.name, '-c'], { env: { ...process.env, 'NODE_USE_ENV_PROXY': '1' }, timeout: 10_000 }).catch(() => null)))
	for (const [i, a] of data.entries()) {
		out.push({
			name: a.name,
			from: a.currentVersion,
			to: a.targetVersion,
			diffUrl: `https://hyrious.me/npm-diff/?a=${a.name}@${cleanVersion(a.currentVersion)}&b=${a.name}@${cleanVersion(a.targetVersion)}`,
			compareUrl: compares[i]?.output.trim()
		})
	}
	return out
}
