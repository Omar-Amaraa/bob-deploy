export class ParseError extends Error {
  readonly section: string;

  constructor(section: string, message = `Could not read the ${section} section.`) {
    super(message);
    this.name = 'ParseError';
    this.section = section;
  }
}
