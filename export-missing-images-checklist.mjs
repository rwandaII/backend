// Checklist version of the missing-images report: one table, a checkbox
// column to tick off as each photo gets added, plus a Has Image column.

import 'dotenv/config';
import pg from 'pg';
import {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  WidthType, HeadingLevel, AlignmentType, ShadingType, VerticalAlign,
} from 'docx';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  SELECT p.id, p.name, p.brand, p.image, p.discontinued, p.qty_in_stock,
         c.name AS category, sc.name AS subcategory
  FROM products p
  JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN categories c ON c.id = sc.category_id
  WHERE p.image IS NULL OR p.image = ''
  ORDER BY c.name, sc.name, p.name
`);

await pool.end();

const CHECKBOX = '☐'; // ☐

const headerCells = ['Done', 'ID', 'Category', 'Subcategory', 'Product Name', 'Brand', 'Qty In Stock', 'Has Image'];
const widths = [700, 700, 2800, 3400, 5200, 2200, 1400, 1600];

function headerRow() {
  return new TableRow({
    tableHeader: true,
    children: headerCells.map((text) => new TableCell({
      shading: { fill: '2F5496', type: ShadingType.CLEAR, color: 'auto' },
      verticalAlign: VerticalAlign.CENTER,
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 18 })],
      })],
    })),
  });
}

function cell(text, { center = false, size = 18 } = {}) {
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text ?? ''), size })],
    })],
  });
}

const dataRows = rows.map((r) => new TableRow({
  children: [
    cell(CHECKBOX, { center: true, size: 22 }),
    cell(r.id, { center: true }),
    cell(r.category),
    cell(r.subcategory),
    cell(r.name),
    cell(r.brand),
    cell(r.qty_in_stock, { center: true }),
    cell('No', { center: true }),
  ],
}));

const table = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  columnWidths: widths,
  rows: [headerRow(), ...dataRows],
});

const doc = new Document({
  sections: [{
    properties: { page: { size: { orientation: 'landscape' } } },
    children: [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: 'Missing Product Images - Checklist' })],
      }),
      new Paragraph({
        children: [new TextRun({
          text: `Generated ${new Date().toISOString().slice(0, 10)} - ${rows.length} products still need a photo. Tick "Done" once a photo has been added and the product record updated.`,
          italics: true,
          size: 20,
        })],
        spacing: { after: 200 },
      }),
      table,
    ],
  }],
});

const buffer = await Packer.toBuffer(doc);
const fs = await import('node:fs');
fs.writeFileSync('products-missing-images-checklist.docx', buffer);
console.log(`Wrote products-missing-images-checklist.docx with ${rows.length} products.`);
