/**
 * Bump the upstream pin (pin.json). The gateway is downloaded for that revision
 * on first launch; nothing is vendored.
 *
 *   node scripts/bump-pin.mjs --check | --latest | --current | <revision>
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { UPSTREAM_REPO, UPSTREAM_BRANCH, fetchUpstream, treeDigest } from '../extensions/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const pinFile = path.join(projectRoot, 'pin.json')
const upstreamDir = path.join(projectRoot, '.upstream')

/** Run git with its arguments as a real argv, never a shell string. */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function readCurrentPin() {
  try {
    const revision = JSON.parse(fs.readFileSync(pinFile, 'utf8')).revision
    return typeof revision === 'string' ? revision : null
  } catch {
    return null
  }
}

function ensureClone() {
  if (fs.existsSync(path.join(upstreamDir, '.git'))) return
  fs.rmSync(upstreamDir, { recursive: true, force: true })
  // blob:none fetches trees and blobs on demand: a shallow checkout of a 13 MB
  // repository should not mean a 1 GB clone.
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${UPSTREAM_REPO}`, upstreamDir])
}

function upstreamHead() {
  ensureClone()
  run('git', ['-C', upstreamDir, 'fetch', '--quiet', 'origin', UPSTREAM_BRANCH])
  return run('git', ['-C', upstreamDir, 'rev-parse', `origin/${UPSTREAM_BRANCH}`]).trim()
}

function describeRevision(revision) {
  try {
    return {
      message: run('git', ['-C', upstreamDir, 'log', '-1', '--format=%s', revision]).trim(),
      author: run('git', ['-C', upstreamDir, 'log', '-1', '--format=%an', revision]).trim(),
      date: run('git', ['-C', upstreamDir, 'log', '-1', '--format=%cI', revision]).trim(),
    }
  } catch {
    return { message: '(unknown)', author: '', date: '' }
  }
}

function commitsBetween(from, to) {
  try {
    const output = run('git', ['-C', upstreamDir, 'log', '--oneline', `${from}..${to}`])
    return output.split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

const flag = process.argv[2]
const args = process.argv.slice(3)

if (flag === '--check') {
  const pin = readCurrentPin()
  if (!pin) {
    console.error('No pin found. Build one first with --latest.')
    process.exit(1)
  }
  const head = upstreamHead()
  console.log(`pin:     ${pin}`)
  console.log(`upstream: ${head} (${UPSTREAM_REPO}@${UPSTREAM_BRANCH})`)
  if (head === pin) {
    console.log(`\nup to date with ${describeRevision(head).message}`)
    process.exit(0)
  }
  const between = commitsBetween(pin, head)
  console.log(`\n${between.length} unreviewed commit(s):`)
  for (const line of between.slice(0, 25)) console.log(`  ${line}`)
  if (between.length > 25) console.log(`  … and ${between.length - 25} more`)
  console.log(`\nreview with: git -C .upstream log --stat ${pin}..${head}`)
  console.log(`adopt with:   node scripts/bump-pin.mjs ${head}`)
  process.exit(between.length > 0 ? 2 : 0)
}

let revision
if (flag === '--latest') {
  revision = upstreamHead()
} else if (flag === '--current') {
  revision = readCurrentPin()
  if (!revision) {
    console.error('No pin to re-stage.')
    process.exit(1)
  }
} else if (flag && /^[0-9a-f]{7,40}$/.test(flag)) {
  ensureClone()
  revision = run('git', ['-C', upstreamDir, 'rev-parse', flag]).trim()
} else {
  console.error('Usage: node scripts/bump-pin.mjs <--check|--latest|--current|<revision>> [--force]')
  process.exit(1)
}

const previous = readCurrentPin()
const description = describeRevision(revision)
console.log(`adopting ${revision}`)
console.log(`  ${description.message}`)
console.log(`  ${description.author}${description.date ? ` · ${description.date}` : ''}`)

if (previous === revision && !args.includes('--force')) {
  console.log('already at this pin; pass --force to re-stage')
  process.exit(0)
}

if (previous) {
  const between = commitsBetween(previous, revision)
  if (between.length > 0) {
    console.log(`\n${between.length} commit(s) since the current pin:`)
    for (const line of between.slice(0, 15)) console.log(`  ${line}`)
    if (between.length > 15) console.log(`  … and ${between.length - 15} more`)
    console.log(`full diff: git -C .upstream log --stat ${previous}..${revision}`)
  }
}

ensureClone()
run('git', ['-C', upstreamDir, 'checkout', '--quiet', revision])
const digest = treeDigest(await fetchUpstream(revision))
fs.writeFileSync(pinFile, `${JSON.stringify({ revision, digest })}\n`)
console.log(`\npin: ${previous ? previous.slice(0, 10) : '(none)'} → ${revision.slice(0, 10)}`)
console.log(`then: npm test && git commit -am "pin: upstream ${revision.slice(0, 10)}"`)
