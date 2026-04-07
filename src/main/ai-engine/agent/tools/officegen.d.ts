declare module 'officegen' {
  function officegen (type: 'docx' | 'pptx' | 'xlsx'): OfficeDocument
  export default officegen

  interface OfficeDocument {
    on (event: 'error', handler: (err: Error) => void): void
    generate (output: NodeJS.WritableStream): void
    // docx
    createP? (): Paragraph
    // pptx
    makeNewSlide? (): Slide
  }

  interface Paragraph {
    addText (text: string, options?: TextOptions): void
  }

  interface TextOptions {
    bold?: boolean
    font_size?: number
    color?: string
  }

  interface Slide {
    name?: string
    addText (text: string, options?: SlideTextOptions): void
  }

  interface SlideTextOptions {
    x?: number
    y?: number
    cx?: string | number
    cy?: string | number
    font_size?: number
    bold?: boolean
    color?: string
  }
}
