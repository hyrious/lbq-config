// Disclaimer: this file was edited by AI.

export async function renderMarkdownStream(stream: AsyncIterable<string>): Promise<void> {
	const { marked } = await import('marked')
	const { default: TerminalRenderer } = await import('marked-terminal')
	marked.setOptions({ renderer: new TerminalRenderer() })

	let buffer = ''
	let inCodeBlock = false
	let codeBlockBuffer = ''

	for await (const chunk of stream) {
		buffer += chunk

		// Check for line breaks (\n)
		const lines = buffer.split('\n')

		// Keep the last incomplete line in buffer
		buffer = lines.pop() || ''

		// Render and output each complete line
		for (const line of lines) {
			// Check if this line contains code fence (```)
			if (line.trimStart().startsWith('```')) {
				if (!inCodeBlock) {
					// Start of code block
					inCodeBlock = true
					codeBlockBuffer = line + '\n'
				} else {
					// End of code block
					codeBlockBuffer += line + '\n'
					const rendered = marked(codeBlockBuffer, { async: false }).trimEnd()
					process.stdout.write(rendered + '\n')
					inCodeBlock = false
					codeBlockBuffer = ''
				}
			} else if (inCodeBlock) {
				// Inside code block, accumulate lines
				codeBlockBuffer += line + '\n'
			} else {
				// Normal line, render immediately
				const rendered = marked(line, { async: false }).trimEnd()
				process.stdout.write(rendered + '\n')
			}
		}
	}

	// Handle remaining buffer
	if (buffer.trim()) {
		if (inCodeBlock) {
			// If still in code block, add to code block buffer
			codeBlockBuffer += buffer
			const rendered = marked(codeBlockBuffer, { async: false }).trimEnd()
			process.stdout.write(rendered + '\n')
		} else {
			const rendered = marked(buffer, { async: false }).trimEnd()
			process.stdout.write(rendered + '\n')
		}
	}
}
