/**
 * DeviceFileList C-004 Tests
 *
 * Tests for the isFilenameSynced helper that accounts for
 * .hda->.mp3 and .hda->.wav filename normalization.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceFileList, isFilenameSynced } from '../DeviceFileList'
import type { DeviceOnlyRecording } from '@/types/unified-recording'

const mocks = vi.hoisted(() => ({
  queueDownload: vi.fn(),
  queueBulkDownloads: vi.fn(),
  downloadRecordingToFile: vi.fn(),
  deleteRecording: vi.fn()
}))

vi.mock('@/hooks/useOperations', () => ({
  useOperations: () => ({
    queueDownload: mocks.queueDownload,
    queueBulkDownloads: mocks.queueBulkDownloads,
    queueTranscription: vi.fn(),
    queueBulkTranscriptions: vi.fn(),
    cancelTranscription: vi.fn(),
    cancelAllTranscriptions: vi.fn(),
    cancelAllDownloads: vi.fn()
  })
}))

vi.mock('@/services/hidock-device', () => ({
  getHiDockDeviceService: () => ({
    downloadRecordingToFile: mocks.downloadRecordingToFile,
    deleteRecording: mocks.deleteRecording
  })
}))

vi.mock('@/store/useAppStore', () => ({
  useIsDownloading: () => false,
  useDownloadProgress: () => null
}))

vi.mock('@/store/ui/useUIStore', () => ({
  useUIStore: (selector: any) => selector({
    currentlyPlayingId: null,
    isPlaying: false
  })
}))

function deviceOnlyRecording(id: string, filename: string): DeviceOnlyRecording {
  return {
    id,
    filename,
    deviceFilename: filename,
    size: 1024,
    duration: 60,
    dateRecorded: new Date('2026-04-27T00:00:00Z'),
    transcriptionStatus: 'none',
    location: 'device-only',
    syncStatus: 'not-synced'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isFilenameSynced (C-004)', () => {
  it('returns true when exact filename is in synced set', () => {
    const synced = new Set(['recording.hda'])
    expect(isFilenameSynced('recording.hda', synced)).toBe(true)
  })

  it('returns true when .mp3 normalized name is in synced set', () => {
    const synced = new Set(['recording.mp3'])
    expect(isFilenameSynced('recording.hda', synced)).toBe(true)
  })

  it('returns true when .wav normalized name is in synced set', () => {
    const synced = new Set(['recording.wav'])
    expect(isFilenameSynced('recording.hda', synced)).toBe(true)
  })

  it('returns false when no variant is in synced set', () => {
    const synced = new Set(['other.mp3'])
    expect(isFilenameSynced('recording.hda', synced)).toBe(false)
  })

  it('handles non-.hda files correctly', () => {
    const synced = new Set(['recording.mp3'])
    expect(isFilenameSynced('recording.mp3', synced)).toBe(true)
  })

  it('handles case-insensitive .HDA extension', () => {
    const synced = new Set(['recording.mp3'])
    expect(isFilenameSynced('recording.HDA', synced)).toBe(true)
  })

  it('returns false for empty synced set', () => {
    const synced = new Set<string>()
    expect(isFilenameSynced('recording.hda', synced)).toBe(false)
  })

  it('handles filenames with multiple dots', () => {
    const synced = new Set(['my.recording.2024.mp3'])
    expect(isFilenameSynced('my.recording.2024.hda', synced)).toBe(true)
  })

  it('does not match partial filenames', () => {
    const synced = new Set(['other-recording.mp3'])
    expect(isFilenameSynced('recording.hda', synced)).toBe(false)
  })
})

describe('DeviceFileList downloads', () => {
  it('queues selected files through the central download queue instead of starting direct USB downloads', async () => {
    mocks.queueBulkDownloads.mockResolvedValue(2)
    const recordings = [
      deviceOnlyRecording('rec-1', '2026Apr23-170206-Rec42.hda'),
      deviceOnlyRecording('rec-2', '2026Apr27-151155-Rec43.hda')
    ]

    render(createElement(DeviceFileList, {
      recordings,
      syncedFilenames: new Set<string>()
    }))

    fireEvent.click(screen.getByLabelText('Select 2026Apr23-170206-Rec42.hda'))
    fireEvent.click(screen.getByLabelText('Select 2026Apr27-151155-Rec43.hda'))
    fireEvent.click(screen.getByRole('button', { name: /Download 2 files/i }))

    await waitFor(() => {
      expect(mocks.queueBulkDownloads).toHaveBeenCalledTimes(1)
    })
    expect(mocks.queueBulkDownloads).toHaveBeenCalledWith(recordings)
    expect(mocks.downloadRecordingToFile).not.toHaveBeenCalled()
  })
})
