import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

test('SkillStore sees flat yaml skills written by the Rust native install_skill', async () => {
  const { SkillStore } = await import('../src/main/settings/skill-store.ts')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbase-skills-'))
  try {
    const store = new SkillStore(userData)
    // Simulate the Rust InstallSkillTool write: flat <id>.yaml in userData/skills
    const yamlId = 'weekly-report-a1b2c3d4'
    const yamlContent = [
      'name: Weekly Report',
      'description: 生成周报',
      'instructions: |',
      '  请按以下结构生成周报……',
      'context: project'
    ].join('\n')
    fs.writeFileSync(path.join(userData, 'skills', `${yamlId}.yaml`), yamlContent)

    const listed = store.list()
    const found = listed.find(skill => skill.id === yamlId)
    assert.ok(found, 'flat yaml skill must appear in list()')
    assert.equal(found.name, 'Weekly Report')
    assert.equal(found.description, '生成周报')
    assert.match(found.content, /周报/)

    const got = store.get(yamlId)
    assert.ok(got, 'get(id) must resolve flat yaml skills')
    assert.equal(got.id, yamlId)

    // The chat panel's setActiveSkills IPC resolves content through store.get
    const contents = []
    const skill = store.get(yamlId)
    if (skill) contents.push(skill.content)
    assert.equal(contents.length, 1)
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
})
