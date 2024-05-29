import { memo, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import PdfPageNumberControl from './pdf-page-number-control'
import PdfZoomButtons from './pdf-zoom-buttons'
import PdfZoomDropdown from './pdf-zoom-dropdown'

import { useResizeObserver } from '@/shared/hooks/use-resize-observer'
import PdfViewerControlsMenuButton from './pdf-viewer-controls-menu-button'

type PdfViewerControlsToolbarProps = {
  setZoom: (zoom: string) => void
  rawScale: number
  setPage: (page: number) => void
  page: number
  totalPages: number
}

function PdfViewerControlsToolbar({
  setZoom,
  rawScale,
  setPage,
  page,
  totalPages,
}: PdfViewerControlsToolbarProps) {
  const toolbarControlsElement = document.querySelector('#toolbar-pdf-controls')

  const [availableWidth, setAvailableWidth] = useState<number>(1000)

  const handleResize = useCallback(
    element => {
      setAvailableWidth(element.offsetWidth)
    },
    [setAvailableWidth]
  )

  const { elementRef: pdfControlsRef } = useResizeObserver(handleResize)

  if (!toolbarControlsElement) {
    return null
  }

  const InnerControlsComponent =
    availableWidth >= 300
      ? PdfViewerControlsToolbarFull
      : PdfViewerControlsToolbarSmall

  return createPortal(
    <div className="pdfjs-viewer-controls" ref={pdfControlsRef}>
      <InnerControlsComponent
        setZoom={setZoom}
        rawScale={rawScale}
        setPage={setPage}
        page={page}
        totalPages={totalPages}
      />
    </div>,

    toolbarControlsElement
  )
}

type InnerControlsProps = {
  setZoom: (zoom: string) => void
  rawScale: number
  setPage: (page: number) => void
  page: number
  totalPages: number
}

function PdfViewerControlsToolbarFull({
  setZoom,
  rawScale,
  setPage,
  page,
  totalPages,
}: InnerControlsProps) {
  return (
    <>
      <PdfPageNumberControl
        setPage={setPage}
        page={page}
        totalPages={totalPages}
      />
      <div className="pdfjs-zoom-controls">
        <PdfZoomButtons setZoom={setZoom} />
        <PdfZoomDropdown rawScale={rawScale} setZoom={setZoom} />
      </div>
    </>
  )
}

function PdfViewerControlsToolbarSmall({
  setZoom,
  rawScale,
  setPage,
  page,
  totalPages,
}: InnerControlsProps) {
  return (
    <div className="pdfjs-viewer-controls-small">
      <PdfZoomDropdown rawScale={rawScale} setZoom={setZoom} />
      <PdfViewerControlsMenuButton
        setZoom={setZoom}
        setPage={setPage}
        page={page}
        totalPages={totalPages}
      />
    </div>
  )
}

export default memo(PdfViewerControlsToolbar)
