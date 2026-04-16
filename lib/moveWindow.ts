export async function moveWindow(appName: string, anchor: string, width?: number, height?: number, window: string = 'front') {
	const { runJxa } = await import('run-jxa')
	return await runJxa(`
		const [appName, anchor, width, height, window] = args
		ObjC.import('AppKit')

		const app = Application(appName)
		app.activate()
		delay(0.1)

		const windowKey = String(window == null ? 'front' : window).toLowerCase()
		const windowIndex = /^(0|[1-9]\\d*)$/.test(windowKey) ? Number(windowKey) : null
		if (windowKey !== 'front' && windowKey !== 'main' && windowIndex == null) {
			throw new Error(\`Unknown window selector: \${window}\`)
		}
		const hasWindow = win => {
			try {
				return !!win && (typeof win.exists !== 'function' || win.exists())
			} catch {
				return false
			}
		}
		const pickWindow = (windows, frontWindow) => {
			if (windowIndex != null) {
				return windows[windowIndex]
			}
			if (typeof frontWindow === 'function') {
				try {
					const win = frontWindow()
					if (hasWindow(win)) return win
				} catch {}
			}
			return windows[0]
		}

		let current
		let setFrame
		try {
			const win = pickWindow(app.windows, app.frontWindow)
			if (!hasWindow(win)) throw new Error('No scriptable window')
			current = win.bounds()
			setFrame = bounds => {
				win.bounds = bounds
				return win.bounds()
			}
		} catch {
			const se = Application('System Events')
			const process = se.processes.byName(appName)
			if (!process.exists()) {
				throw new Error(\`No process for \${appName}\`)
			}
			const win = pickWindow(process.windows, process.frontWindow)
			if (!hasWindow(win)) {
				throw new Error(\`No window for \${appName} (\${windowKey})\`)
			}
			const [x, y] = win.position()
			const [width, height] = win.size()
			current = { x, y, width, height }
			setFrame = bounds => {
				win.position = [bounds.x, bounds.y]
				win.size = [bounds.width, bounds.height]
				const [x, y] = win.position()
				const [width, height] = win.size()
				return { x, y, width, height }
			}
		}

		const nextWidth = width == null ? current.width : width
		const nextHeight = height == null ? current.height : height

		const screens = $.NSScreen.screens.js.map(screen => ({
			frame: ObjC.deepUnwrap(screen.frame),
			visibleFrame: ObjC.deepUnwrap(screen.visibleFrame),
		}))
		const desktopTop = screens.reduce((top, screen) => {
			const screenTop = screen.frame.origin.y + screen.frame.size.height
			return Math.max(top, screenTop)
		}, Number.NEGATIVE_INFINITY)
		const centerX = current.x + current.width / 2
		const centerY = current.y + current.height / 2
		const screen = screens.find(screen => {
			const left = screen.frame.origin.x
			const right = left + screen.frame.size.width
			const top = desktopTop - (screen.frame.origin.y + screen.frame.size.height)
			const bottom = top + screen.frame.size.height
			return centerX >= left && centerX < right && centerY >= top && centerY < bottom
		}) || screens[0]
		const visible = screen.visibleFrame
		const left = visible.origin.x
		const right = visible.origin.x + visible.size.width - nextWidth
		const top = desktopTop - (visible.origin.y + visible.size.height)
		const bottom = desktopTop - visible.origin.y - nextHeight
		const centerHorizontal = left + (visible.size.width - nextWidth) / 2
		const centerVertical = top + (visible.size.height - nextHeight) / 2
		const clamp = (value, min, max) => max < min ? min : Math.min(Math.max(value, min), max)
		const normalized = String(anchor).toLowerCase()
		const aliases = {
			'top-left': 'tl',
			'left-top': 'tl',
			'upper-left': 'tl',
			'左上': 'tl',
			'top-right': 'tr',
			'right-top': 'tr',
			'upper-right': 'tr',
			'右上': 'tr',
			'bottom-left': 'bl',
			'left-bottom': 'bl',
			'lower-left': 'bl',
			'左下': 'bl',
			'bottom-right': 'br',
			'right-bottom': 'br',
			'lower-right': 'br',
			'右下': 'br',
			middle: 'center',
			centre: 'center',
			'中间': 'center',
		}
		const position = aliases[normalized] || normalized
		let x = current.x
		let y = current.y

		if (position === 'tl') {
			x = left
			y = top
		} else if (position === 'tr') {
			x = right
			y = top
		} else if (position === 'bl') {
			x = left
			y = bottom
		} else if (position === 'br') {
			x = right
			y = bottom
		} else if (position === 'left') {
			x = left
			y = clamp(current.y, top, bottom)
		} else if (position === 'right') {
			x = right
			y = clamp(current.y, top, bottom)
		} else if (position === 'top') {
			x = clamp(current.x, left, right)
			y = top
		} else if (position === 'bottom') {
			x = clamp(current.x, left, right)
			y = bottom
		} else if (position === 'center' || position === 'c') {
			x = centerHorizontal
			y = centerVertical
		} else {
			throw new Error(\`Unknown anchor: \${anchor}\`)
		}

		return setFrame({ x, y, width: nextWidth, height: nextHeight })
	`, [appName, anchor, width ?? null, height ?? null, window])
}
