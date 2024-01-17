import { AppleNotesImporter } from '../apple-notes';
import { ScanConverter } from './convert-scan';
import { TableConverter } from './convert-table';
import {
	ANAlignment,
	ANAttachment,
	ANAttributeRun,
	ANBaseline,
	ANColor,
	ANConverter,
	ANDocument,
	ANFontWeight,
	ANFragmentPair,
	ANMultiRun,
	ANNote,
	ANStyleType,
	ANTableObject
} from './models';

const FRAGMENT_SPLIT = /(^[\n ]+|(?:[\n ]+)?\n(?:[\n ]+)?|[\n ]+$)/;
// const FRAGMENT_SPLIT = /(^\s+|(?:\s+)?\n(?:\s+)?|\s+$)/;
// carrillos: There is an issue here. If I remove the first ^\s+ - Then we fix a number off issues.
const NOTE_URI = /applenotes:note\/([-0-9a-f]+)(?:\?ownerIdentifier=.*)?/;

const DEFAULT_EMOJI = '.AppleColorEmojiUI';
const LIST_STYLES = [
	ANStyleType.DottedList, ANStyleType.DashedList, ANStyleType.NumberedList, ANStyleType.Checkbox
];
const MAX_TITLE_LENGTH = 70;

export class NoteConverter extends ANConverter {
	note: ANNote;

	listNumber = 0;
	listIndent = 0;
	multiRun = ANMultiRun.None;

	static protobufType = 'ciofecaforensics.Document';

	constructor(importer: AppleNotesImporter, document: ANDocument | ANTableObject) {
		super(importer);
		this.note = document.note;
	}

	parseTokens(): ANFragmentPair[] {
		let i = 0;
		let offsetStart = 0;
		let offsetEnd = 0;
		let tokens = [];
		let cursorStart = 0;
		let cursorEnd = 0

		// console.log('AN: parse: begin: ', this.note.attributeRun);
		// console.log('AN: parse: begin');
		while (i < this.note.attributeRun.length) {
			let attr: ANAttributeRun;
			let attrText = '';
			let nextIsSame = true;
			/* First, merge tokens with the same attributes */
			do {
				attr = this.note.attributeRun[i];
				offsetEnd = offsetEnd + attr.length;
				// carrillo - original, experimenting with delayed substring
				// attrText += this.note.noteText.substring(offsetStart, offsetEnd);
				// console.log('AN: parse: noteText.substring: ', attrText);

				offsetStart = offsetEnd;
				cursorEnd = offsetEnd; // advance
				nextIsSame = (i == this.note.attributeRun.length - 1)
					? false
					: attrEquals(attr, this.note.attributeRun[i + 1]);

				i++;
			}
			while (nextIsSame);

			// TODO: carrillo: testing less substring actions
			attrText += this.note.noteText.substring(cursorStart, cursorEnd);
			// console.log('AN: parse: noteText.substring: ', attrText);
			cursorStart = cursorEnd;

			/* Then, since Obsidian doesn't like formatting crossing new lines or 
			starting/ending at spaces, divide tokens based on that */
			// console.log('AN: token fragments: ', attr, attrText.split(FRAGMENT_SPLIT));
			for (let fragment of attrText.split(FRAGMENT_SPLIT)) {
				if (!fragment) continue;
				// fragment = '^' + fragment;
				fragment = fragment;
				tokens.push({ attr, fragment });
				//console.log('AN: token: ['+ fragment +']');
			}
			// console.log('AN: token end');
		}
		return tokens;
	}

	async format(table = false): Promise<string> {
		let fragments = this.parseTokens();

		let firstLineSkip = !table && this.importer.omitFirstLine && this.note.noteText.contains('\n');

		let converted = '';
		// console.log('AN: fragments: ', fragments);
		for (let j = 0; j < fragments.length; j++) {
			let { attr, fragment } = fragments[j];

			if (firstLineSkip) {
				if (fragment.contains('\n') || fragment.length > MAX_TITLE_LENGTH || attr.attachmentInfo) {
					// carrillos: Fix for: https://github.com/obsidianmd/obsidian-importer/issues/153
					firstLineSkip = false;
				}
				else {
					continue;
				}
			}

			attr.fragment = fragment;
			// attr.atLineStart = j == 0 ? true : fragments[j - 1]?.fragment.contains('\n');
			attr.atLineStart = j == 0 ? true : (
				/^[\n]+$/.test(fragments[j - 1]?.fragment) ||
				/ \n+$/.test(fragments[j - 1]?.fragment) ||
				((/\n $/.test(fragments[j - 1]?.fragment) || /\t+$/.test(fragments[j - 1]?.fragment)) &&
				(attr.paragraphStyle?.styleType == ANStyleType.DashedList || attr.paragraphStyle?.styleType == ANStyleType.DottedList || attr.paragraphStyle?.styleType == ANStyleType.Checkbox))
			);

			converted += this.formatMultiRun(attr, 'real');

			let replaceString = attr.paragraphStyle?.styleType == ANStyleType.NumberedList ||
				attr.paragraphStyle?.styleType == ANStyleType.Checkbox ? ' ' : ' ';

			if (/^[ ]+$/.test(attr.fragment) && this.multiRun != ANMultiRun.Monospaced) {
				converted += this.formatParagraph(attr).replace(/[ ]+/g, replaceString);
			}
			else if (/^[\n]+$/.test(attr.fragment) && this.multiRun != ANMultiRun.Monospaced) {
				converted += attr.fragment.replace(/[ ]+/g, replaceString);
			}
			else if (!/\S/.test(attr.fragment) || this.multiRun == ANMultiRun.Monospaced) {

				if (this.multiRun == ANMultiRun.Monospaced) {
					converted += attr.fragment;
				}
				else {
					if (/\n/.test(attr.fragment)) {
						if(attr.paragraphStyle?.styleType == ANStyleType.DashedList || attr.paragraphStyle?.styleType == ANStyleType.DottedList) {
							converted += this.formatParagraph(attr).replace(/[ ]+/g, '');	
						} else {
							converted += this.formatParagraph(attr).replace(/[ ]+/g, replaceString);
						}
					}
					else {
						converted += attr.fragment.replace(/[ ]+/g, replaceString);
					}
				}
			}
			else if (attr.attachmentInfo) {
				converted += await this.formatAttachment(attr);
			}
			else if (attr.superscript || (attr.underlined && !this.attrContainsLink(attr)) || attr.color || attr.font || this.multiRun == ANMultiRun.Alignment) {
				converted += await this.formatHtmlAttr(attr);
			}
			else {
				converted += await this.formatAttr(attr);
			}
		}

		if (this.multiRun != ANMultiRun.None) converted += this.formatMultiRun({} as ANAttributeRun, 'fake');
		if (table) converted.replace('\n', '<br>').replace('|', '&#124;');

		return converted.trim();
	}

	/** Format things that cover multiple ANAttributeRuns. */
	formatMultiRun(attr: ANAttributeRun, runType: string): string {
		const styleType = attr.paragraphStyle?.styleType;
		let prefix = '';

		switch (this.multiRun) {
			case ANMultiRun.List:
				if (
					(attr.paragraphStyle?.indentAmount == 0 &&
						!LIST_STYLES.includes(styleType!)) ||
					isBlockAttachment(attr)
				) {
					this.multiRun = ANMultiRun.None;
				}
				break;

			case ANMultiRun.Monospaced:
				// carrillos: Fix missing tags by excluding attachmentInfo and space characters. This even finds tags that Apple Notes did not convert into an official tag.
				// if we've reached the end of a monospaced text or we hit a hashtag.
				if (styleType != ANStyleType.Monospaced || attrContainsHashtag(attr)) { // carrillos
					this.multiRun = ANMultiRun.None;
					prefix += '```\n';
				}
				break;

			case ANMultiRun.Alignment:
				if (!attr.paragraphStyle?.alignment) {
					this.multiRun = ANMultiRun.None;
					prefix += '</p>\n';
				}
				break;
		}

		// Separate since one may end and another start immediately
		if (this.multiRun == ANMultiRun.None) {
		
			if(attrContainsHashtag(attr)) { 
				// Apple tags are monospaced - however, we only want to catch non-tag-monospaced text.
				// Avoid monospace checks for hashtags - We don't care if a tag is monospaced by apple, it won't be in obsidian.
				// DO NOTHING
			}
			else if (styleType == ANStyleType.Monospaced && !/^[ ]+$/.test(attr.fragment)) { // carrillos
				// We don't open backticks here, so we don't set Monospaced, we then skip closing.
				this.multiRun = ANMultiRun.Monospaced;
				prefix += '\n```\n';
			}
			else if (LIST_STYLES.includes(styleType as ANStyleType)) {
				this.multiRun = ANMultiRun.List;

				// Apple Notes lets users start a list as indented, so add a initial non-indented bit to those
				if (attr.paragraphStyle?.indentAmount) {
					// prefix += '\n- &nbsp;\n';
					// Adding two spaces achieves similar results, without adding a visible nbsp in edit mode.
					// We gain a collapsible list on the same line as the nested list. Without the nbsp text.
					// Tradeoff: This feels cleaner, but it is less obvious in code.
					// Findings: https://forum.obsidian.md/t/indenting-a-list-removes-checkboxes/53477/6
					prefix += '\n  - \n';
				}
			}
			else if (attr.paragraphStyle?.alignment) {
				this.multiRun = ANMultiRun.Alignment;
				const val = this.convertAlign(attr?.paragraphStyle?.alignment);
				prefix += `\n<p style="text-align:${val};margin:0">`;
			}
		}

		return prefix;
	}

	/** Since putting markdown inside inline html tags is currentlyproblematic in Live Preview, this is a separate
	 parser for those that is activated when HTML-only stuff (eg underline, font size) is needed */
	async formatHtmlAttr(attr: ANAttributeRun): Promise<string> {
		if (attr.strikethrough) attr.fragment = `<s>${attr.fragment}</s>`;
		// reduce the amount of unnecessary html links - even when a "color" style is applied.
		if (attr.underlined && !this.attrContainsLink(attr)) attr.fragment = `<u>${attr.fragment}</u>`;

		if (attr.superscript == ANBaseline.Super) attr.fragment = `<sup>${attr.fragment}</sup>`;
		if (attr.superscript == ANBaseline.Sub) attr.fragment = `<sub>${attr.fragment}</sub>`;

		let style = '';

		switch (attr.fontWeight) {
			case ANFontWeight.Bold:
				attr.fragment = `<b>${attr.fragment}</b>`;
				break;
			case ANFontWeight.Italic:
				attr.fragment = `<i>${attr.fragment}</i>`;
				break;
			case ANFontWeight.BoldItalic:
				attr.fragment = `<b><i>${attr.fragment}</i></b>`;
				break;
		}

		if (attr.font?.fontName && attr.font.fontName !== DEFAULT_EMOJI) {
			style += `font-family:${attr.font.fontName};`;
		}

		if (attr.font?.pointSize) style += `font-size:${attr.font.pointSize}pt;`;
		if (attr.color) style += `color:${this.convertColor(attr.color)};`;

		// carrillo: Do not need links with style in Obsidian, and much prefer to reduce the html added to notes
		this.doFormatLink(attr);
		// if (this.attrContainsLink(attr)) {
		// 	this.doFormatHtmlLink(attr, style);
		// }
		// else {
		// 	this.doFormatLink(attr);
		// }

		if (attr.atLineStart) {
			return this.formatParagraph(attr);
		}
		else {
			return attr.fragment;
		}
	}

	async formatAttr(attr: ANAttributeRun): Promise<string> {
		let ignoreLineStart = false;
		if(attr.fragment == ' ') {
			// Never happening.
			return attr.fragment;
		}
	
		switch (attr.fontWeight) {
			case ANFontWeight.Bold:
				attr.fragment = `**${attr.fragment}**`;
				ignoreLineStart = true;
				break;
			case ANFontWeight.Italic:
				attr.fragment = `*${attr.fragment}*`;
				ignoreLineStart = true;
				break;
			case ANFontWeight.BoldItalic:
				attr.fragment = `***${attr.fragment}***`;
				ignoreLineStart = true;
				break;
		}

		if (attr.strikethrough) {
			ignoreLineStart = true;
			attr.fragment = `~~${attr.fragment}~~`;
		}
		this.doFormatLink(attr);

		if (attr.atLineStart) {
			return this.formatParagraph(attr);
		}
		else {
			if(ignoreLineStart) {
				return ' '+ attr.fragment;
			}
			return attr.fragment;
		}
	}

	formatParagraph(attr: ANAttributeRun): string {
	
		const paragraphIndentAmount = attr.paragraphStyle?.indentAmount || 0;
		const indent = '\t'.repeat(paragraphIndentAmount);
		const styleType = attr.paragraphStyle?.styleType;
		let prelude = attr.paragraphStyle?.blockquote ? '> ' : '';

		if (
			this.listNumber != 0 &&
			((styleType !== ANStyleType.NumberedList && styleType !== ANStyleType.DashedList && styleType !== ANStyleType.DottedList) || // Suspect that we preserve this for nested lists
				(this.listIndent !== paragraphIndentAmount))
		) {
			this.listIndent = paragraphIndentAmount;
			this.listNumber = 0;
		}

		let attrTrim = '';
		switch (styleType) {
			case ANStyleType.Title:
				attrTrim = attr.fragment.trim();
				if(attrTrim == '') { return attr.fragment; }
				return `${prelude}# ${attr.fragment}`;

			case ANStyleType.Heading:
				attrTrim = attr.fragment.trim();
				if(attrTrim == '') { return attr.fragment; }
				return `${prelude}## ${attr.fragment}`;

			case ANStyleType.Subheading:
				attrTrim = attr.fragment.trim();
				if(attrTrim == '') { return attr.fragment; }
				return `${prelude}### ${attr.fragment}`;

			case ANStyleType.DashedList:
			case ANStyleType.DottedList:
				attrTrim = attr.fragment.trim();
				if(attrTrim == '' && !attr.atLineStart) { return attr.fragment; }
				return `${prelude}${indent}- ${attr.fragment}`;

			case ANStyleType.NumberedList:
				if(!attr.atLineStart && /\n/.test(attr.fragment)) {
					prelude = '\n' + prelude;
					attrTrim = ''; // already, but want to be clear about the usage below
				} else if (!attr.atLineStart && attr.fragment.trim() == '') {
					return attr.fragment
				} else {
					prelude = '' + prelude;
					attrTrim = attr.fragment;
				}
				this.listNumber++;
				return `${prelude}${indent}${this.listNumber}. ${attrTrim}`;

			case ANStyleType.Checkbox:
				attrTrim = attr.fragment.trim();
				if(attrTrim == '' && !attr.atLineStart) { return attr.fragment; } // return without bullet

				const box = attr.paragraphStyle!.checklist?.done ? '[x]' : '[ ]';
				return `${prelude}${indent}- ${box} ${attrTrim}`;
		}

		// Not a list but indented in line with one
		if (this.multiRun == ANMultiRun.List) prelude += indent;

		return `${prelude}${attr.fragment}`;
	}

	async formatAttachment(attr: ANAttributeRun): Promise<string> {
		let row, id, converter;

		switch (attr.attachmentInfo?.typeUti) {
			case ANAttachment.Hashtag:
			case ANAttachment.Mention:
				row = await this.importer.database.get`
					SELECT zalttext FROM ziccloudsyncingobject 
					WHERE zidentifier = ${attr.attachmentInfo.attachmentIdentifier}`;

				return row.ZALTTEXT;

			case ANAttachment.InternalLink:
				row = await this.importer.database.get`
					SELECT ztokencontentidentifier FROM ziccloudsyncingobject 
					WHERE zidentifier = ${attr.attachmentInfo.attachmentIdentifier}`;

				return await this.getInternalLink(row.ZTOKENCONTENTIDENTIFIER);

			case ANAttachment.Table:
				row = await this.importer.database.get`
					SELECT hex(zmergeabledata1) as zhexdata FROM ziccloudsyncingobject 
					WHERE zidentifier = ${attr.attachmentInfo.attachmentIdentifier}`;

				converter = this.importer.decodeData(row.zhexdata, TableConverter);
				return await converter.format();

			case ANAttachment.UrlCard:
				row = await this.importer.database.get`
					SELECT ztitle, zurlstring FROM ziccloudsyncingobject 
					WHERE zidentifier = ${attr.attachmentInfo.attachmentIdentifier}`;

				return `[**${row.ZTITLE}**](${row.ZURLSTRING})`;

			case ANAttachment.Scan:
				row = await this.importer.database.get`
					SELECT hex(zmergeabledata1) as zhexdata FROM ziccloudsyncingobject 
					WHERE zidentifier = ${attr.attachmentInfo.attachmentIdentifier}`;

				converter = this.importer.decodeData(row.zhexdata, ScanConverter);
				return await converter.format();

			case ANAttachment.ModifiedScan:
			case ANAttachment.DrawingLegacy:
			case ANAttachment.DrawingLegacy2:
			case ANAttachment.Drawing:
				row = await this.importer.database.get`
					SELECT z_pk, zhandwritingsummary 
					FROM (SELECT *, NULL AS zhandwritingsummary FROM ziccloudsyncingobject) 
					WHERE zidentifier = ${attr.attachmentInfo.attachmentIdentifier}`;

				id = row?.Z_PK;
				break;

			// Actual file on disk (eg image, audio, video, pdf, vcard)
			// Hundreds of different utis so not in the enum
			default:
				row = await this.importer.database.get`
					SELECT zmedia FROM ziccloudsyncingobject 
					WHERE zidentifier = ${attr.attachmentInfo?.attachmentIdentifier}`;

				id = row?.ZMEDIA;
				break;
		}

		if (!id) {
			// Doesn't have an associated file, so unknown
			return ` **(unknown attachment: ${attr.attachmentInfo?.typeUti})** `;
		}

		const attachment = await this.importer.resolveAttachment(id, attr.attachmentInfo!.typeUti);
		let link = attachment
			? `\n${this.app.fileManager.generateMarkdownLink(attachment, '/')}\n` 
			: ` **(error reading attachment)**`;
		
		if (this.importer.includeHandwriting && row.ZHANDWRITINGSUMMARY) {
			link = `\n> [!Handwriting]-\n> ${row.ZHANDWRITINGSUMMARY.replace('\n', '\n> ')}${link}`;
		}
		
		return link;
	}

	async getInternalLink(uri: string, name: string | undefined = undefined): Promise<string> {
		const identifier = uri.match(NOTE_URI)![1];

		const row = await this.importer.database.get`
			SELECT z_pk FROM ziccloudsyncingobject 
			WHERE zidentifier = ${identifier.toUpperCase()}`;

		let file = await this.importer.resolveNote(row.Z_PK);
		if (!file) return '(unknown file link)';

		return this.app.fileManager.generateMarkdownLink(
			file, this.importer.rootFolder.path, undefined, name
		);
	}

	convertColor(color: ANColor): string {
		let hexcode = '#';

		for (const channel of Object.values(color)) {
			hexcode += Math.floor(channel * 255).toString(16);
		}

		return hexcode;
	}

	convertAlign(alignment: ANAlignment): string {
		switch (alignment) {
			default:
				return 'left';
			case ANAlignment.Centre:
				return 'center';
			case ANAlignment.Right:
				return 'right';
			case ANAlignment.Justify:
				return 'justify';
		}
	}

	// carrillo
	attrContainsLink (attr: ANAttributeRun) {
		// if(!attr.link) { return false; }
	
		// let isLink = attr.underlined && attr.link && (!/^[\n\t ]+$/.test(attr.link));
		// carrillo: links are underlined generally, but not if in a list :)
		return attr.link || /^http/.test(attr.fragment);
	}

	// carrillo - mutates attr.fragment
	async doFormatHtmlLink (attr: ANAttributeRun, style:string = '') {
		if(!attr.link) { return; }
	
		if (!NOTE_URI.test(attr.link)) {
			if (style != '') style = ` style="${style}"`;
	
			attr.fragment =
				`<a href="${attr.link}" rel="noopener" class="external-link"` +
				` target="_blank"${style}>${attr.fragment}</a>`;
		}
		else if (style != '') {
			console.log('AN: doFormatHtmlLink: style: ', style);
			// carrillo - This was previously being applied very often
			if (attr.link) {
				console.log('AN: doFormatHtmlLink: getInternalLink: ', attr);
				attr.fragment = await this.getInternalLink(attr.link, attr.fragment);
			}
	
			attr.fragment = `<span style="${style}">${attr.fragment}</span>`;
		}
	}

	// carrillo - mutates attr.fragment
	async doFormatLink(attr: ANAttributeRun) {
		if(!attr.link) { return; }
	
		// if they match do nothing to modify the url and Obsidian will manage the format.
		if (attr.link == attr.fragment) { return; }

		// Apple Note Links with custom titles. This errors in my testing (Carrillo), attempting to recreate a file
		if (NOTE_URI.test(attr.link)) {
			console.log('AN: doFormatLink: getInternalLink: ', attr);
			attr.fragment = await this.getInternalLink(attr.link, attr.fragment);
		}
		else {
			attr.fragment = `[${attr.fragment}](${attr.link})`;
		}
		
	}
}

function isBlockAttachment(attr: ANAttributeRun) {
	if (!attr.attachmentInfo) return false;
	return !attr.attachmentInfo.typeUti.includes('com.apple.notes.inlinetextattachment');
}

function attrEquals(a: ANAttributeRun, b: ANAttributeRun): boolean {
	if (!b || a.$type != b.$type) return false;

	for (let field of a.$type.fieldsArray) {
		if (field.name == 'length') continue;

		if (a[field.name]?.$type && b[field.name]?.$type) {
			// Is a child ANAttributeRun
			if (!attrEquals(a[field.name], b[field.name])) return false;
		}
		else {
			if (a[field.name] != b[field.name]) return false;
		}
	}

	return true;
}

// carrillo
function attrContainsHashtag (attr: ANAttributeRun) {
	return attr.attachmentInfo?.typeUti == ANAttachment.Hashtag;
}

