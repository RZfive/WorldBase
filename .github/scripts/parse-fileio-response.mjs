import { readFileSync } from 'node:fs'

const input = readFileSync(0, 'utf8').trim()

if (!input) {
  console.error('File.io response was empty.')
  process.exit(1)
}

let data

try {
  data = JSON.parse(input)
} catch (error) {
  console.error('Failed to parse File.io response as JSON:', error)
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
