/** Lane graph layout contract for the workbench Git history. */

import { describe, expect, it } from 'vitest'
import type { WorkbenchGitLogEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { buildGitGraph } from '../src/client/git-graph.ts'

function commit(hash: string, parents: string[]): WorkbenchGitLogEntry {
  return { hash, shortHash: hash.slice(0, 7), author: 'a', date: '2026-01-01', message: hash, parents }
}

describe('buildGitGraph', () => {
  it('lays out a linear history on one lane', () => {
    const rows = buildGitGraph([commit('c3', ['c2']), commit('c2', ['c1']), commit('c1', [])])
    expect(rows).toHaveLength(3)
    expect(rows[0]?.cells).toEqual(['node'])
    expect(rows[1]?.cells).toEqual(['node'])
    expect(rows[2]?.cells).toEqual(['node'])
    expect(rows.map(row => row.merge)).toEqual([false, false, false])
  })

  it('adds a second lane for a merge commit second parent', () => {
    const rows = buildGitGraph([
      commit('m', ['a', 'b']),
      commit('b', ['base']),
      commit('a', ['base']),
      commit('base', []),
    ])
    // merge row: node on lane 0, edge on the new lane 1
    expect(rows[0]?.cells).toEqual(['node', 'edge'])
    expect(rows[0]?.merge).toBe(true)
    // the second parent lane continues
    expect(rows[1]?.cells).toEqual(['edge', 'node'])
    expect(rows[2]?.cells).toEqual(['node', 'edge'])
    expect(rows[3]?.cells).toEqual(['node', 'edge'])
  })

  it('keeps a root commit node even with no parents', () => {
    const rows = buildGitGraph([commit('root', [])])
    expect(rows[0]?.cells).toEqual(['node'])
  })
})
