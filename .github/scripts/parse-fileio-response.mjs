import { readFileSync } from 'node:fs'

let input

try {
  input = readFileSync(0, 'utf8').trim()
} catch (error) {
  console.error('Failed to read File.io response from stdin:', error)
  process.exit(1)
}

if (!input) {
  console.error('File.io response was empty.')
  process.exit(1)
}

if (input.startsWith('<') || input.startsWith('<!')) {
  console.error('File.io returned an HTML page instead of JSON.')
  console.error('Response preview:', input.slice(0, 300))
  process.exit(1)
}

let data

try {
  data = JSON.parse(input)
} catch (error) {
  console.error('Failed to parse File.io response as JSON:', error.message)
  console.error('Response preview:', input.slice(0, 500))
  process.exit(1)
}

if (data.success !== true) {
  console.error('File.io upload was not successful:', data)
  process.exit(1)
}

if (!data.link || typeof data.link !== 'string') {
  console.error('File.io response missing link:', data)
  process.exit(1)
}

process.stdout.write(data.link)
