/**
 * Lane-based commit graph layout for the workbench Git history.
 *
 * Each commit occupies one lane column; edges (parents) continue as vertical
 * lines in the rows below until their commit appears. A merge commit adds
 * its extra parents as new lanes; a branch-out appears as a new lane
 * starting at the row whose parent is not yet on any lane. The layout is a
 * pure function of the newest-first commit list, so the UI renders the
 * same VSCode-style graph the tests pin.
 * @module @deepseek-ai/dsh-client-ui-workbench/git-graph
 */

import type { WorkbenchGitLogEntry } from '@deepseek-ai/dsh-api-remotes/client'

/** One graph cell: empty, a continuing edge, or this row's commit node. */
export type GraphCell = 'empty' | 'edge' | 'node'

/** One history row: the commit plus its per-lane cells, left = newest lane order. */
export interface GitGraphRow {
  commit: WorkbenchGitLogEntry
  cells: GraphCell[]
  /** True for a commit with more than one parent (an intentional merge). */
  merge: boolean
}

/**
 * Build the lane graph for a newest-first commit list.
 * @param commits - the commits to lay out, newest first.
 * @returns one row per commit with its lane cells.
 */
export function buildGitGraph(commits: readonly WorkbenchGitLogEntry[]): GitGraphRow[] {
  const lanes: (string | null)[] = []
  const rows: GitGraphRow[] = []
  for (const commit of commits) {
    let laneIndex = lanes.findIndex(head => head === commit.hash)
    if (laneIndex === -1) {
      laneIndex = lanes.length
      lanes.push(commit.hash)
    }
    const cells: GraphCell[] = lanes.map(head => (head === null ? 'empty' : 'edge'))
    cells[laneIndex] = 'node'
    const [first, ...rest] = commit.parents
    lanes[laneIndex] = first ?? null
    let addedLanes = 0
    for (const parent of rest) {
      if (!lanes.includes(parent)) {
        lanes.push(parent)
        addedLanes += 1
      }
    }
    // A merge's extra parents begin their branch line at this row, so the
    // row carries the new lane's edge cell alongside the merge node.
    for (let index = 0; index < addedLanes; index += 1) cells.push('edge')
    rows.push({ commit, cells, merge: commit.parents.length > 1 })
  }
  return rows
}
