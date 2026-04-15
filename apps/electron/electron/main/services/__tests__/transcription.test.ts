/**
 * Transcription Service Tests
 *
 * BUG-TX-001: recordings.status stays 'transcribing' forever after transcription failure
 *   OBSERVED: User sees "Transcription in progress..." badge on recordings that failed
 *   ROOT CAUSE: processQueue() catch block updates queue item to 'failed' but did NOT
 *   update recordings.status back from 'transcribing' to 'failed'
 *   FIX: Added updateRecordingStatus(recordingId, 'failed') in the catch block
 *
 * @vitest-environment node
 */

// This test runs in node environment, so we must define mocks BEFORE imports
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track calls to updateRecordingStatus
const mockUpdateRecordingStatus = vi.fn()
const mockUpdateQueueItem = vi.fn()
const mockGetQueueItems = vi.fn()
const mockGetRecordingById = vi.fn()
const mockStatSync = vi.fn()
const mockUnlink = vi.fn()
const mockExecFile = vi.fn()

// Mock database
vi.mock('../database', () => ({
  getRecordingById: (...args: any[]) => mockGetRecordingById(...args),
  updateRecordingStatus: (...args: any[]) => mockUpdateRecordingStatus(...args),
  updateRecordingTranscriptionStatus: (...args: any[]) => mockUpdateRecordingStatus(...args),
  insertTranscript: vi.fn(),
  getQueueItems: (...args: any[]) => mockGetQueueItems(...args),
  updateQueueItem: (...args: any[]) => mockUpdateQueueItem(...args),
  updateQueueProgress: vi.fn(),
  getMeetingById: vi.fn(),
  findCandidateMeetingsForRecording: vi.fn(() => []),
  addRecordingMeetingCandidate: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  removeFromQueueByRecordingId: vi.fn(),
  cancelPendingTranscriptions: vi.fn(() => 0),
  acquireTranscriptionLock: vi.fn().mockReturnValue(true),
  releaseTranscriptionLock: vi.fn().mockReturnValue(true),
  clearStaleTranscriptionLock: vi.fn(), // Called on startTranscriptionProcessor()
  run: vi.fn(),
  queryOne: vi.fn()
}))

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: { handle: vi.fn() }
}))

// Mock config
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    transcription: {
      geminiApiKey: 'test-api-key',
      geminiModel: 'gemini-2.0-flash'
    }
  }))
}))

// Mock google generative AI - make it fail
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(() => ({
    getGenerativeModel: vi.fn(() => ({
      generateContent: vi.fn().mockRejectedValue(new Error('API rate limit exceeded'))
    }))
  }))
}))

// Mock fs - simple approach that works in jsdom environment
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: (...args: any[]) => mockStatSync(...args),
    readFile: vi.fn((_path: string, cb: (err: null, data: Buffer) => void) => {
      cb(null, Buffer.from('fake audio data'))
    }),
    unlink: (...args: any[]) => mockUnlink(...args)
  }
})

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args)
}))

// Mock vector store
vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

describe('Transcription Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStatSync.mockImplementation((target: string) => ({
      size: target.endsWith('.m4a') ? 4 * 1024 * 1024 : 1024
    }))
    mockUnlink.mockImplementation((_path: string, cb: (err: null) => void) => cb(null))
    mockExecFile.mockImplementation((_cmd: string, _args: string[], optsOrCb: any, maybeCb?: any) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
      cb(null, '', '')
    })
  })

  describe('prepareAudioForTranscription', () => {
    it('should reuse small files without transcoding', async () => {
      const { prepareAudioForTranscription } = await import('../transcription')

      const prepared = await prepareAudioForTranscription('/recordings/test.wav')

      expect(prepared.transcoded).toBe(false)
      expect(prepared.filePath).toBe('/recordings/test.wav')
      expect(prepared.mimeType).toBe('audio/wav')
      expect(mockExecFile).not.toHaveBeenCalled()
    })

    it('should transcode large files before inline upload and clean up temp files', async () => {
      mockStatSync.mockImplementation((target: string) => ({
        size: target.endsWith('.m4a') ? 4 * 1024 * 1024 : 25 * 1024 * 1024
      }))

      const { prepareAudioForTranscription } = await import('../transcription')

      const prepared = await prepareAudioForTranscription('/recordings/large.wav')

      expect(prepared.transcoded).toBe(true)
      expect(prepared.mimeType).toBe('audio/mp4')
      expect(prepared.filePath).toContain('hidock-transcription-')
      expect(mockExecFile).toHaveBeenCalled()

      await prepared.cleanup?.()
      expect(mockUnlink).toHaveBeenCalled()
    })
  })

  describe('BUG-TX-001: recordings.status stuck at transcribing after failure', () => {
    it('should update recordings.status to failed when transcription fails', async () => {
      const mockQueueItem = {
        id: 'queue-1',
        recording_id: 'rec-123',
        filename: 'test.wav',
        status: 'pending',
        attempts: 0
      }
      mockGetQueueItems.mockReturnValue([mockQueueItem])
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        status: 'complete'
      })

      const { startTranscriptionProcessor, stopTranscriptionProcessor } = await import('../transcription')

      startTranscriptionProcessor()
      await new Promise(resolve => setTimeout(resolve, 500))
      stopTranscriptionProcessor()

      // The key assertion: when transcription fails, the recording status
      // must be updated to indicate failure so the UI stops showing "In Progress"
      const statusCalls = mockUpdateRecordingStatus.mock.calls

      // After the fix, we expect:
      // 1. updateRecordingTranscriptionStatus(rec-123, 'processing') - before attempt
      // 2. updateRecordingTranscriptionStatus(rec-123, 'error') - after failure
      // Even if the exact flow varies due to mocking, the FAILURE status call must exist
      const hasFailureCall = statusCalls.some(
        (call: any[]) => call[0] === 'rec-123' && call[1] === 'error'
      )

      // Also verify the queue item was marked as failed
      const queueUpdateCalls = mockUpdateQueueItem.mock.calls
      const hasQueueFailure = queueUpdateCalls.some(
        (call: any[]) => call[0] === 'queue-1' && call[1] === 'failed'
      )

      expect(hasQueueFailure).toBe(true)
      expect(hasFailureCall).toBe(true)
    })
  })
})
