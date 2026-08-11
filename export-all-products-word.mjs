// Exports every product in the catalog into a single table in a .docx file.

import 'dotenv/config';
import pg from 'pg';
import {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  WidthType, HeadingLevel, AlignmentType, ShadingType, VerticalAlign,
} from 'docx';

const CHECKED = '☑';
const UNCHECKED = '☐';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  SELECT p.id, p.name, p.brand, p.barcode, p.unit_price, p.total_price, p.currency,
         p.qty_in_stock, p.discontinued, p.image,
         c.name AS category, sc.name AS subcategory
  FROM products p
  JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN categories c ON c.id = sc.category_id
  ORDER BY c.name, sc.name, p.name
`);

await pool.end();

const headerCells = ['ID', 'Category', 'Subcategory', 'Product Name', 'Brand', 'Unit Price (excl. VAT)', 'Total Price (incl. 18% VAT)', 'Qty In Stock', 'Discontinued', 'Has Image ✓'];

function headerRow() {
  return new TableRow({
    tableHeader: true,
    children: headerCells.map((text) => new TableCell({
      shading: { fill: '2F5496', type: ShadingType.CLEAR, color: 'auto' },
      children: [new Paragraph({
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

const money = (v, currency) => (v === null || v === undefined ? '' : `${Number(v).toLocaleString()} ${currency}`);

const dataRows = rows.map((r) => new TableRow({
  children: [
    cell(r.id),
    cell(r.category),
    cell(r.subcategory),
    cell(r.name),
    cell(r.brand),
    cell(money(r.unit_price, r.currency)),
    cell(money(r.total_price, r.currency)),
    cell(r.qty_in_stock, { center: true }),
    cell(r.discontinued ? 'Yes' : 'No', { center: true }),
    cell(r.image ? CHECKED : UNCHECKED, { center: true, size: 22 }),
  ],
}));

const table = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [headerRow(), ...dataRows],
});

const doc = new Document({
  sections: [{
    properties: { page: { size: { orientation: 'landscape' } } },
    children: [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: 'Target Traders - Full Product Catalog' })],
      }),
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun({
          text: `Generated ${new Date().toISOString().slice(0, 10)} - ${rows.length} products total`,
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
fs.writeFileSync('all-products-checklist.docx', buffer);
console.log(`Wrote all-products-checklist.docx with ${rows.length} products.`);
