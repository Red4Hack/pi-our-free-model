import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ENTRY_REL_PATH, UPSTREAM_REPO, isListed, sha256, snapshotDir } from './config.ts'

/* ==== upstream download, verification, staging ==== */

/**
 * Parse a USTAR archive into `{relPath: bytes}`.
 *
 * Walked in memory rather than unpacked to disk, so an unexpected or hostile path
 * cannot escape the staging directory, and the allow-list is applied before a
 * byte is written.
 *
 * Accepts gzip input because codeload serves `application/x-gzip`. Handles the
 * GNU long-name (0x4c) headers GitHub emits for paths over 100 characters, which
 * the channel-pack sources do have.
 */
function readTar(tar) {
  const files = new Map()
  let pendingName = null
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8')
    const name = rawName.replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField, 8) || 0
    const typeFlag = header[156]
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    offset += 512
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    if (typeFlag === 0x4c) {
      pendingName = body.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    // pax per-file, pax global, directory, pax global extended
    if (typeFlag === 0x78 || typeFlag === 0x58 || typeFlag === 0x35 || typeFlag === 0x47) continue

    const baseName = pendingName ?? name
    pendingName = null
    const combined = prefix ? `${prefix}/${baseName}` : baseName
    if (combined === '' || combined === './') continue
    // Strip the leading `./` and the single top-level directory (`repo-sha/`).
    const relPath = combined.replace(/^\.\//, '').replace(/^[^/]+\//, '')
    if (!isListed(relPath)) continue
    if (!files.has(relPath)) files.set(relPath, Buffer.from(body))
  }
  return files
}

export function readTarball(tarballBuffer) {
  const tar = tarballBuffer.length > 2 && tarballBuffer[0] === 0x1f && tarballBuffer[1] === 0x8b
    ? zlib.gunzipSync(tarballBuffer)
    : tarballBuffer
  return readTar(tar)
}

/**
 * Walk every relative import reachable from the gateway entry point.
 *
 * This is what makes an unreviewed download checkable. Without a pinned manifest
 * the strongest honest statement is "the tree is closed": every module it claims
 * to import is present, so it is neither a truncated archive nor a tree with a
 * file silently dropped.
 */
export function verifyClosure(files) {
  const problems = []
  if (!files.has(ENTRY_REL_PATH)) return { ok: false, problems: [`missing entry: ${ENTRY_REL_PATH}`], fileCount: 0 }
  const seen = new Set()
  const queue = [ENTRY_REL_PATH]
  const importPattern = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g
  while (queue.length > 0) {
    const relPath = queue.shift()
    if (seen.has(relPath)) continue
    seen.add(relPath)
    const bytes = files.get(relPath)
    if (bytes === undefined) {
      problems.push(`unresolved import: ${relPath}`)
      continue
    }
    let match
    importPattern.lastIndex = 0
    while ((match = importPattern.exec(bytes.toString('utf8'))) !== null) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), match[1]))
      // Climbing out of the tree means the staged layout is not the layout the
      // code expects — the failure that otherwise shows up as an ENOENT at import.
      if (resolved.startsWith('..')) {
        problems.push(`escapes the staged tree: ${relPath} -> ${match[1]}`)
        continue
      }
      if (!seen.has(resolved)) queue.push(resolved)
    }
  }
  return { ok: problems.length === 0, problems, fileCount: seen.size }
}

/** One sha256 over every (path, content hash) pair, sorted: the value pin.json commits to. */
export function treeDigest(files) {
  const lines = [...files].map(([p, bytes]) => `${p}\0${sha256(bytes)}\n`).sort()
  return sha256(Buffer.from(lines.join('')))
}

/**
 * Download the file set for one revision.
 *
 * The codeload tarball is preferred: one request, GitHub's own infrastructure,
 * and it is the exact tree for that commit rather than whatever the branch points
 * at now. One retry, because a transient failure should not cost the user a pin.
 */
export async function fetchUpstream(revision, { fetchImpl = fetch, signal } = {}) {
  const url = `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${revision}`
  let lastError
  for (const attempt of [1, 2]) {
    const response = await fetchImpl(url, {
      signal,
      headers: { 'user-agent': 'pi-our-free-model-sync', accept: 'application/gzip' },
      redirect: 'follow',
    })
    if (response.ok) {
      const files = readTarball(Buffer.from(await response.arrayBuffer()))
      if (files.has(ENTRY_REL_PATH)) return files
      lastError = new Error('tarball contained no gateway entry point')
    } else {
      lastError = new Error(`upstream ${revision} returned HTTP ${response.status}`)
      // 404 means the revision does not exist; retrying cannot help.
      if (response.status === 404) break
    }
    if (attempt === 1 && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw lastError ?? new Error('upstream download failed')
}

/**
 * Atomically stage a verified snapshot.
 *
 * Written into a sibling staging directory and renamed only once complete, so a
 * crash mid-write cannot leave a half-populated tree that a later run mistakes
 * for a usable snapshot. The previous snapshot is kept until the rename succeeds
 * and restored if it does not.
 */
export function stageSnapshot(cacheRoot, revision, files) {
  const target = snapshotDir(cacheRoot, revision)
  if (fs.existsSync(path.join(target, '.complete'))) return { target, changed: false }

  const staging = `${target}.staging-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    for (const [relPath, bytes] of files) {
      const destination = path.join(staging, relPath)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, bytes)
    }
    // Inside the staging tree on purpose: the marker must only ever exist in a
    // directory that already holds every file.
    fs.writeFileSync(path.join(staging, '.complete'), new Date().toISOString() + '\n', 'utf8')

    const previous = `${target}.previous-${process.pid}`
    if (fs.existsSync(target)) fs.renameSync(target, previous)
    try {
      fs.renameSync(staging, target)
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, target)
      throw error
    }
    fs.rmSync(previous, { recursive: true, force: true })
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return { target, changed: true }
}

/**
 * Resolve the gateway's CLI entry inside a staged tree.
 *
 * Read from the gateway package's own package.json rather than hard-coded, so an
 * upstream rename of cli.mjs surfaces as a clear error instead of an ENOENT from
 * deep inside spawn().
 */
export function cliEntryOf(snapshot) {
  let entry = 'cli.mjs'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(snapshot, 'packages', 'standalone', 'package.json'), 'utf8'))
    const match = /([\w.-]+\.mjs)/.exec(pkg?.scripts?.start ?? '')
    if (match) entry = match[1]
  } catch {
    /* fall back to the conventional name; the existence check reports it */
  }
  const resolved = path.join(snapshot, 'packages', 'standalone', entry)
  if (!fs.existsSync(resolved)) {
    throw new Error(`gateway entry not found: ${path.relative(snapshot, resolved)}`)
  }
  return resolved
}

/**
 * Read the asset manifest the gateway's management layer serves from.
 *
 * management.mjs reads web/assets.json at runtime and refuses to serve anything
 * not named in it. Vite hashes the bundle names on every build, so this reads
 * the staged list instead of hard-coding one — otherwise the console would
 * silently serve a stale bundle after an upstream rebuild.
 */
export function webAssetsOf(snapshot) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(snapshot, 'packages', 'standalone', 'web', 'assets.json'), 'utf8'))
    if (!Array.isArray(list) || list.some((name) => typeof name !== 'string')) {
      throw new Error('assets.json is not a list of names')
    }
    return list
  } catch (error) {
    throw new Error(`cannot read web assets manifest: ${error.message}`)
  }
}

/** True when a staged snapshot is complete and has an identifiable entry point. */
export function isUsableSnapshot(snapshot, { deep = true } = {}) {
  try {
    cliEntryOf(snapshot)
    webAssetsOf(snapshot)
    if (!fs.existsSync(path.join(snapshot, '.complete'))) return false
    // The closure walk reads the whole tree; startup skips it (staging already verified).
    if (!deep) return true
    // The entry and the manifest existing is not enough: a partially deleted
    // cache would pass those and then fail at import time, which surfaces as a
    // gateway that never becomes healthy. Walking the closure turns that into a
    // detectable "unusable" here instead.
    const files = readSnapshotFiles(snapshot)
    if (files === null) return false
    return verifyClosure(files).ok
  } catch {
    return false
  }
}

/** Read a staged tree into the `{relPath: bytes}` shape the closure walker wants. */
function readSnapshotFiles(snapshot) {
  const files = new Map()
  const visit = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) { visit(path.join(current, entry.name), childRel); continue }
      if (!entry.isFile()) continue
      if (!isListed(childRel)) continue
      files.set(childRel, fs.readFileSync(path.join(current, entry.name)))
    }
  }
  try {
    visit(snapshot, '')
    return files.size > 0 ? files : null
  } catch {
    return null
  }
}

