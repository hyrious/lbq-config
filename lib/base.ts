export type RegisterFunction = {
	(pattern: string | RegExp, run: (arg: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
	(pattern: string | RegExp, pattern2: string | RegExp, run: (arg: RegExpMatchArray, arg2: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
	(pattern: string | RegExp, pattern2: string | RegExp, pattern3: string | RegExp, run: (arg: RegExpMatchArray, arg2: RegExpMatchArray, arg3: RegExpMatchArray, ...args: string[]) => unknown, description?: string): void;
}

/** `^1` &rarr; `1` */
export function cleanVersion(v: string): string {
	return v.replace(/^[^\d]+/, '')
}

/** `try { decodeURIComponent(str) }` */
export function tryUnescape(str: string): string {
	try { return decodeURIComponent(str) }
	catch { return str }
}

/** `https://github.com/...` &rarr; `github.com` */
export function hostname(str: string): string {
	try { return (new URL(str)).hostname }
	catch { return str.split('/')[0] || str }
}

export function anchor(text: string, href: string): string {
	return `\x1b]8;;${href}\x07${text}\x1b]8;;\x07`
}

export type TableCell = string | { readonly label: string, readonly link: string }

function cellLen(cell: TableCell): number {
	if (typeof cell === 'object') {
		return cell.label.length
	} else {
		return cell.length
	}
}

export function showTable(table: readonly TableCell[][] | ((table: TableCell[][]) => void)): void {
	if (typeof table === 'function') {
		const fn = table
		table = []
		fn(table as TableCell[][])
	}
	const maxLens = Array.from({ length: table[0].length }, () => 0)
	table.forEach(row => row.forEach((cell, i) => { maxLens[i] = Math.max(maxLens[i], cellLen(cell)) }))
	table.forEach(row => {
		console.log('  ' + row.map((cell, i) => {
			if (typeof cell === 'object') {
				return anchor(cell.label, cell.link) + ' '.repeat(maxLens[i] - cell.label.length)
			} else {
				return cell + ' '.repeat(maxLens[i] - cell.length)
			}
		}).join('  '))
	})
}

export function getErrorMessage(error: any): string {
	if (typeof error == 'string') {
		if (error[0] == '{') return getErrorMessage(JSON.parse(error));
		return error;
	}
	if (typeof error == 'object' && error !== null) {
		const m = error.stack || error.message || error.code
		if (m) return String(m);
	}
	return String(error) || 'Error'
}
