import { promisify } from 'util'
import fs from 'fs'
import request from 'request'
import stream from 'stream'
import logger from '@overleaf/logger'
import _ from 'lodash'
import { URL } from 'url'
import OError from '@overleaf/o-error'
import Settings from '@overleaf/settings'
import {
  fetchStream,
  fetchNothing,
  RequestFailedError,
} from '@overleaf/fetch-utils'
import * as Versions from './Versions.js'
import * as Errors from './Errors.js'
import * as LocalFileWriter from './LocalFileWriter.js'
import * as HashManager from './HashManager.js'
import * as HistoryBlobTranslator from './HistoryBlobTranslator.js'

const HTTP_REQUEST_TIMEOUT = Settings.apis.history_v1.requestTimeout

/**
 * Container for functions that need to be mocked in tests
 *
 * TODO: Rewrite tests in terms of exported functions only
 */
export const _mocks = {}

class StringStream extends stream.Readable {
  _read() {}
}

_mocks.getMostRecentChunk = (projectId, historyId, callback) => {
  const path = `projects/${historyId}/latest/history`
  logger.debug({ projectId, historyId }, 'getting chunk from history service')
  _requestChunk({ path, json: true }, callback)
}

/**
 * @param {Callback} callback
 */
export function getMostRecentChunk(projectId, historyId, callback) {
  _mocks.getMostRecentChunk(projectId, historyId, callback)
}

/**
 * @param {Callback} callback
 */
export function getChunkAtVersion(projectId, historyId, version, callback) {
  const path = `projects/${historyId}/versions/${version}/history`
  logger.debug(
    { projectId, historyId, version },
    'getting chunk from history service for version'
  )
  _requestChunk({ path, json: true }, callback)
}

export function getMostRecentVersion(projectId, historyId, callback) {
  getMostRecentChunk(projectId, historyId, (error, chunk) => {
    if (error) {
      return callback(OError.tag(error))
    }
    const mostRecentVersion =
      chunk.chunk.startVersion + (chunk.chunk.history.changes || []).length
    const lastChange = _.last(
      _.sortBy(chunk.chunk.history.changes || [], x => x.timestamp)
    )
    // find the latest project and doc versions in the chunk
    _getLatestProjectVersion(projectId, chunk, (err1, projectVersion) =>
      _getLatestV2DocVersions(projectId, chunk, (err2, v2DocVersions) => {
        // return the project and doc versions
        const projectStructureAndDocVersions = {
          project: projectVersion,
          docs: v2DocVersions,
        }
        callback(
          err1 || err2,
          mostRecentVersion,
          projectStructureAndDocVersions,
          lastChange
        )
      })
    )
  })
}

function _requestChunk(options, callback) {
  _requestHistoryService(options, (err, chunk) => {
    if (err) {
      return callback(OError.tag(err))
    }
    if (
      chunk == null ||
      chunk.chunk == null ||
      chunk.chunk.startVersion == null
    ) {
      return callback(new OError('unexpected response'))
    }
    callback(null, chunk)
  })
}

function _getLatestProjectVersion(projectId, chunk, callback) {
  // find the initial project version
  let projectVersion =
    chunk.chunk.history.snapshot && chunk.chunk.history.snapshot.projectVersion
  // keep track of any errors
  let error = null
  // iterate over the changes in chunk to find the most recent project version
  for (const change of chunk.chunk.history.changes || []) {
    if (change.projectVersion != null) {
      if (
        projectVersion != null &&
        Versions.lt(change.projectVersion, projectVersion)
      ) {
        logger.warn(
          { projectId, chunk, projectVersion, change },
          'project structure version out of order in chunk'
        )
        if (!error) {
          error = new Errors.OpsOutOfOrderError(
            'project structure version out of order'
          )
        }
      } else {
        projectVersion = change.projectVersion
      }
    }
  }
  callback(error, projectVersion)
}

function _getLatestV2DocVersions(projectId, chunk, callback) {
  // find the initial doc versions (indexed by docId as this is immutable)
  const v2DocVersions =
    (chunk.chunk.history.snapshot &&
      chunk.chunk.history.snapshot.v2DocVersions) ||
    {}
  // keep track of any errors
  let error = null
  // iterate over the changes in the chunk to find the most recent doc versions
  for (const change of chunk.chunk.history.changes || []) {
    if (change.v2DocVersions != null) {
      for (const docId in change.v2DocVersions) {
        const docInfo = change.v2DocVersions[docId]
        const { v } = docInfo
        if (
          v2DocVersions[docId] &&
          v2DocVersions[docId].v != null &&
          Versions.lt(v, v2DocVersions[docId].v)
        ) {
          logger.warn(
            {
              projectId,
              docId,
              changeVersion: docInfo,
              previousVersion: v2DocVersions[docId],
            },
            'doc version out of order in chunk'
          )
          if (!error) {
            error = new Errors.OpsOutOfOrderError('doc version out of order')
          }
        } else {
          v2DocVersions[docId] = docInfo
        }
      }
    }
  }
  callback(error, v2DocVersions)
}

export function getProjectBlob(historyId, blobHash, callback) {
  logger.debug({ historyId, blobHash }, 'getting blob from history service')
  _requestHistoryService(
    { path: `projects/${historyId}/blobs/${blobHash}` },
    callback
  )
}

/**
 * @param {Callback} callback
 */
export function getProjectBlobStream(historyId, blobHash, callback) {
  const url = `${Settings.overleaf.history.host}/projects/${historyId}/blobs/${blobHash}`
  logger.debug(
    { historyId, blobHash },
    'getting blob stream from history service'
  )
  fetchStream(url, getHistoryFetchOptions())
    .then(stream => {
      callback(null, stream)
    })
    .catch(err => callback(OError.tag(err)))
}

export function sendChanges(
  projectId,
  historyId,
  changes,
  endVersion,
  callback
) {
  logger.debug(
    { projectId, historyId, endVersion },
    'sending changes to history service'
  )
  _requestHistoryService(
    {
      path: `projects/${historyId}/legacy_changes`,
      qs: { end_version: endVersion },
      method: 'POST',
      json: changes,
    },
    error => {
      if (error) {
        OError.tag(error, 'failed to send changes to v1', {
          projectId,
          historyId,
          endVersion,
          errorCode: error.code,
          statusCode: error.statusCode,
          body: error.body,
        })
        logger.warn(error)
        return callback(error)
      }
      callback()
    }
  )
}

function createBlobFromString(historyId, data, fileId, callback) {
  const stringStream = new StringStream()
  stringStream.push(data)
  stringStream.push(null)
  LocalFileWriter.bufferOnDisk(
    stringStream,
    '',
    fileId,
    (fsPath, cb) => {
      _createBlob(historyId, fsPath, cb)
    },
    callback
  )
}

export function createBlobForUpdate(projectId, historyId, update, callback) {
  callback = _.once(callback)

  if (update.doc != null && update.docLines != null) {
    let ranges
    try {
      ranges = HistoryBlobTranslator.createRangeBlobDataFromUpdate(update)
    } catch (error) {
      return callback(error)
    }
    createBlobFromString(
      historyId,
      update.docLines,
      `project-${projectId}-doc-${update.doc}`,
      (err, fileHash) => {
        if (err) {
          return callback(err)
        }
        if (ranges) {
          createBlobFromString(
            historyId,
            JSON.stringify(ranges),
            `project-${projectId}-doc-${update.doc}-ranges`,
            (err, rangesHash) => {
              if (err) {
                return callback(err)
              }
              logger.debug(
                { fileHash, rangesHash },
                'created blobs for both ranges and content'
              )
              return callback(null, { file: fileHash, ranges: rangesHash })
            }
          )
        } else {
          logger.debug({ fileHash }, 'created blob for content')
          return callback(null, { file: fileHash })
        }
      }
    )
  } else if (update.file != null && update.url != null) {
    // Rewrite the filestore url to point to the location in the local
    // settings for this service (this avoids problems with cross-
    // datacentre requests when running filestore in multiple locations).
    const { pathname: fileStorePath } = new URL(update.url)
    const urlMatch = /^\/project\/([0-9a-f]{24})\/file\/([0-9a-f]{24})$/.exec(
      fileStorePath
    )
    if (urlMatch == null) {
      return callback(new OError('invalid file for blob creation'))
    }
    if (urlMatch[1] !== projectId) {
      return callback(new OError('invalid project for blob creation'))
    }
    const fileId = urlMatch[2]
    const filestoreURL = `${Settings.apis.filestore.url}/project/${projectId}/file/${fileId}`
    fetchStream(filestoreURL, {
      signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT),
    })
      .then(stream => {
        LocalFileWriter.bufferOnDisk(
          stream,
          filestoreURL,
          `project-${projectId}-file-${fileId}`,
          (fsPath, cb) => {
            _createBlob(historyId, fsPath, cb)
          },
          (err, fileHash) => {
            if (err) {
              return callback(err)
            }
            if (update.hash && update.hash !== fileHash) {
              logger.warn(
                { projectId, fileId, webHash: update.hash, fileHash },
                'hash mismatch between web and project-history'
              )
            }
            logger.debug({ fileHash }, 'created blob for file')
            callback(null, { file: fileHash })
          }
        )
      })
      .catch(err => {
        if (err instanceof RequestFailedError && err.response.status === 404) {
          logger.warn(
            { projectId, historyId, filestoreURL },
            'File contents not found in filestore. Storing in history as an empty file'
          )
          const emptyStream = new StringStream()
          LocalFileWriter.bufferOnDisk(
            emptyStream,
            filestoreURL,
            `project-${projectId}-file-${fileId}`,
            (fsPath, cb) => {
              _createBlob(historyId, fsPath, cb)
            },
            (err, fileHash) => {
              if (err) {
                return callback(err)
              }
              logger.debug({ fileHash }, 'created empty blob for file')
              callback(null, { file: fileHash })
            }
          )
          emptyStream.push(null) // send an EOF signal
        } else {
          callback(OError.tag(err, 'error from filestore', { filestoreURL }))
        }
      })
  } else {
    const error = new OError('invalid update for blob creation')
    callback(error)
  }
}

function _createBlob(historyId, fsPath, _callback) {
  const callback = _.once(_callback)

  HashManager._getBlobHash(fsPath, (error, hash, byteLength) => {
    if (error) {
      return callback(OError.tag(error))
    }
    const outStream = fs.createReadStream(fsPath)

    logger.debug(
      { fsPath, historyId, hash, byteLength },
      'sending blob to history service'
    )
    const url = `${Settings.overleaf.history.host}/projects/${historyId}/blobs/${hash}`
    fetchNothing(url, {
      method: 'PUT',
      body: outStream,
      headers: { 'Content-Length': byteLength }, // add the content length to work around problems with chunked encoding in node 18
      ...getHistoryFetchOptions(),
    })
      .then(res => {
        callback(null, hash)
      })
      .catch(err => {
        callback(OError.tag(err))
      })
  })
}

export function initializeProject(historyId, callback) {
  _requestHistoryService(
    {
      method: 'POST',
      path: 'projects',
      json: historyId == null ? true : { projectId: historyId },
    },
    (error, project) => {
      if (error) {
        return callback(OError.tag(error))
      }

      const id = project.projectId
      if (id == null) {
        error = new OError('history store did not return a project id', id)
        return callback(error)
      }

      callback(null, id)
    }
  )
}

export function deleteProject(projectId, callback) {
  _requestHistoryService(
    { method: 'DELETE', path: `projects/${projectId}` },
    callback
  )
}

const getProjectBlobAsync = promisify(getProjectBlob)

class BlobStore {
  constructor(projectId) {
    this.projectId = projectId
  }

  async getString(hash) {
    return await getProjectBlobAsync(this.projectId, hash)
  }

  async getObject(hash) {
    const string = await this.getString(hash)
    return JSON.parse(string)
  }
}

export function getBlobStore(projectId) {
  return new BlobStore(projectId)
}

function _requestOptions(options) {
  const requestOptions = {
    method: options.method || 'GET',
    url: `${Settings.overleaf.history.host}/${options.path}`,
    timeout: HTTP_REQUEST_TIMEOUT,
    auth: {
      user: Settings.overleaf.history.user,
      pass: Settings.overleaf.history.pass,
      sendImmediately: true,
    },
  }

  if (options.json != null) {
    requestOptions.json = options.json
  }

  if (options.body != null) {
    requestOptions.body = options.body
  }

  if (options.qs != null) {
    requestOptions.qs = options.qs
  }

  return requestOptions
}

/**
 * @return {RequestInit}
 */
function getHistoryFetchOptions() {
  return {
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT),
    basicAuth: {
      user: Settings.overleaf.history.user,
      password: Settings.overleaf.history.pass,
    },
  }
}

function _requestHistoryService(options, callback) {
  const requestOptions = _requestOptions(options)
  request(requestOptions, (error, res, body) => {
    if (error) {
      return callback(OError.tag(error))
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      callback(null, body)
    } else {
      error = new OError(
        `history store a non-success status code: ${res.statusCode}`
      )
      error.statusCode = res.statusCode
      error.body = body
      logger.warn({ err: error }, error.message)
      callback(error)
    }
  })
}

export const promises = {
  getMostRecentChunk: promisify(getMostRecentChunk),
  getChunkAtVersion: promisify(getChunkAtVersion),
  getMostRecentVersion: promisify(getMostRecentVersion),
  getProjectBlob: promisify(getProjectBlob),
  getProjectBlobStream: promisify(getProjectBlobStream),
  sendChanges: promisify(sendChanges),
  createBlobForUpdate: promisify(createBlobForUpdate),
  initializeProject: promisify(initializeProject),
  deleteProject: promisify(deleteProject),
}
