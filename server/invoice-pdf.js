/* =========================================================
   INVOICE PDF (A4)
   Rendered on the server from the stored, immutable invoice document.
========================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { amountInWords, formatINR, stateName } from "../shared/pricing.js";
import { INVOICE_THANK_YOU, PAYMENT_METHODS, balanceDueText, invoiceDate, invoiceTermsFor, separateShippingAddress } from "../shared/constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const FONT = {
  regular: path.join(here, "fonts", "NotoSans-Regular.ttf"),
  semibold: path.join(here, "fonts", "NotoSans-SemiBold.ttf"),
  bold: path.join(here, "fonts", "NotoSans-Bold.ttf")
};

const NAVY = "#12294d";
const GOLD = "#c89400";
const GOLD_TEXT = "#a67a00"; // GOLD darkened so small bold text stays legible in print
const INK = "#1d2433";
const MUTED = "#5f6b7d";
const LINE = "#dfe3ea";
const SOFT = "#f5f6f8";

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const CONTENT = PAGE.width - PAGE.margin * 2;

function money(paise) {
  return formatINR(paise ?? 0);
}


function localLogo(logo) {
  if (!logo || /[\\/]/.test(logo) || !/\.(jpe?g|png)$/i.test(logo)) return null;
  const file = path.join(root, logo);
  return fs.existsSync(file) ? file : null;
}

export function renderInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE.margin,
      bufferPages: true,
      info: {
        Title: `${invoice.documentTitle} ${invoice.invoiceNo}`,
        Author: invoice.seller.businessName,
        Subject: invoice.orderNo ? `Order ${invoice.orderNo}` : `Invoice ${invoice.invoiceNo}`
      }
    });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("regular", FONT.regular);
    doc.registerFont("semibold", FONT.semibold);
    doc.registerFont("bold", FONT.bold);

    try {
      draw(doc, invoice);
    } catch (error) {
      reject(error);
      return;
    }
    doc.end();
  });
}

function text(doc, value, x, y, options = {}) {
  const { font = "regular", size = 9, color = INK, ...rest } = options;
  doc.font(font).fontSize(size).fillColor(color).text(String(value ?? ""), x, y, { lineGap: 1.5, ...rest });
  return doc.y;
}

function draw(doc, invoice) {
  const { seller, customer } = invoice;
  const gst = invoice.taxSnapshot?.mode === "gst";
  const left = PAGE.margin;
  let y = PAGE.margin;

  /* ---------------- header ---------------- */
  doc.rect(0, 0, PAGE.width, 6).fill(NAVY);
  doc.rect(0, 6, PAGE.width, 2).fill(GOLD);

  const logo = localLogo(seller.logo);
  let textX = left;
  if (logo) {
    doc.image(logo, left, y, { width: 64, height: 64 });
    textX = left + 76;
  }
  text(doc, seller.businessName, textX, y + 2, { font: "bold", size: 15, color: NAVY, width: 280 });
  let sy = text(doc, seller.tagline, textX, doc.y, { size: 8.5, color: GOLD, width: 280 });
  const contact = [
    seller.address,
    [seller.phone && `Phone/WhatsApp: ${seller.phone}`, seller.email].filter(Boolean).join("  ·  "),
    seller.instagram && `Instagram: @${seller.instagram}`,
    seller.gstin && `GSTIN: ${seller.gstin}${seller.stateCode ? `  ·  State: ${stateName(seller.stateCode)} (${seller.stateCode})` : ""}`
  ].filter(Boolean);
  for (const line of contact) sy = text(doc, line, textX, sy + 1, { size: 8, color: MUTED, width: 280 });

  const rightX = left + CONTENT - 200;
  text(doc, invoice.documentTitle.toUpperCase(), rightX, y, { font: "bold", size: 18, color: NAVY, width: 200, align: "right", characterSpacing: 1 });
  // Offline invoices have no order, so the row is left out rather than blank.
  const meta = [
    ["Invoice No.", invoice.invoiceNo],
    ["Invoice Date", invoiceDate(invoice.issuedAt)],
    invoice.orderNo && ["Order No.", invoice.orderNo]
  ].filter(Boolean);
  let my = y + 30;
  for (const [label, value] of meta) {
    text(doc, label, rightX, my, { size: 8, color: MUTED, width: 90 });
    text(doc, value, rightX + 80, my, { font: "semibold", size: 8.5, width: 120, align: "right" });
    my += 13;
  }

  y = Math.max(sy, my, y + 70) + 14;

  if (invoice.status === "cancelled") {
    doc.save();
    doc.rect(left, y, CONTENT, 22).fill("#fdecec");
    text(doc, `CANCELLED${invoice.cancelReason ? ` — ${invoice.cancelReason}` : ""}`, left + 10, y + 5, { font: "bold", size: 9, color: "#b42318", width: CONTENT - 20 });
    doc.restore();
    y += 30;
  }
  if (invoice.preview) {
    doc.rect(left, y, CONTENT, 22).fill("#fff6e0");
    text(doc, "PREVIEW — not a valid invoice until issued", left + 10, y + 5, { font: "bold", size: 9, color: "#8a6200", width: CONTENT - 20 });
    y += 30;
  }

  /* ---------------- parties ---------------- */
  const colW = (CONTENT - 16) / 2;
  const billLines = [
    customer.business,
    customer.billingAddress,
    customer.phone && `Phone: ${customer.phone.replace(/^91(?=\d{10}$)/, "+91 ")}`,
    customer.email,
    customer.gstin && `GSTIN: ${customer.gstin}`
  ].filter(Boolean);
  const shipLines = [separateShippingAddress(customer) || "Same as billing address"];
  if (invoice.placeOfSupply) shipLines.push(`Place of supply: ${stateName(invoice.placeOfSupply)} (${invoice.placeOfSupply})`);

  const partyTop = y;
  text(doc, "BILL TO", left, y, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.8 });
  let by = text(doc, customer.name, left, doc.y + 2, { font: "bold", size: 10.5, width: colW });
  for (const line of billLines) by = text(doc, line, left, by + 1, { size: 8.5, color: INK, width: colW });

  const shipX = left + colW + 16;
  text(doc, "SHIP TO", shipX, partyTop, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.8 });
  let shy = doc.y + 2;
  for (const line of shipLines) shy = text(doc, line, shipX, shy + 1, { size: 8.5, width: colW });

  y = Math.max(by, shy) + 16;

  /* ---------------- items table ---------------- */
  const columns = gst
    ? [
      { key: "no", label: "#", width: 20, align: "left" },
      { key: "item", label: "Particulars", width: 165, align: "left" },
      { key: "rate", label: "Rate", width: 62, align: "right" },
      { key: "qty", label: "Qnt", width: 38, align: "right" },
      { key: "taxable", label: "Taxable", width: 70, align: "right" },
      { key: "gst", label: "GST", width: 38, align: "right" },
      { key: "tax", label: "Tax", width: 52, align: "right" },
      { key: "amount", label: "Amount", width: CONTENT - 445, align: "right" }
    ]
    : [
      { key: "no", label: "#", width: 22, align: "left" },
      { key: "item", label: "Particulars", width: 225, align: "left" },
      { key: "rate", label: "Rate", width: 72, align: "right" },
      { key: "qty", label: "Qnt", width: 50, align: "right" },
      { key: "discount", label: "Discount", width: 72, align: "right" },
      { key: "amount", label: "Amount", width: CONTENT - 441, align: "right" }
    ];

  const header = () => {
    doc.rect(left, y, CONTENT, 20).fill(NAVY);
    let x = left;
    for (const column of columns) {
      text(doc, column.label, x + 5, y + 5.5, { font: "semibold", size: 8, color: "#ffffff", width: column.width - 10, align: column.align });
      x += column.width;
    }
    y += 20;
  };
  header();

  invoice.lines.forEach((line, index) => {
    const values = {
      no: String(index + 1),
      item: null,
      qty: `${line.qty} ${line.unit || ""}`.trim(),
      rate: money(line.listPrice && line.listPrice > line.unitPrice && !gst ? line.listPrice : line.unitPrice),
      discount: line.discount ? `-${money(line.discount)}` : "—",
      taxable: money(line.taxable),
      gst: `${line.gstRate ?? 0}%`,
      tax: money(line.taxAmount),
      amount: money(line.total)
    };
    const itemCol = columns.find(c => c.key === "item");
    doc.font("semibold").fontSize(8.5);
    // lineGap matches text(), so the SKU line never collides with a wrapped name.
    const nameHeight = doc.heightOfString(line.name, { width: itemCol.width - 10, lineGap: 1.5 });
    const rowHeight = Math.max(nameHeight + 18, 28);

    if (y + rowHeight > PAGE.height - 120) {
      doc.addPage();
      y = PAGE.margin;
      header();
    }
    if (index % 2 === 1) doc.rect(left, y, CONTENT, rowHeight).fill(SOFT);

    let x = left;
    for (const column of columns) {
      if (column.key === "item") {
        text(doc, line.name, x + 5, y + 5, { font: "semibold", size: 8.5, width: column.width - 10 });
        const sub = [line.sku, line.hsn && `HSN ${line.hsn}`, gst && line.discount ? `Disc. ${money(line.discount)}` : ""].filter(Boolean).join("  ·  ");
        text(doc, sub, x + 5, y + 5 + nameHeight, { size: 7.5, color: MUTED, width: column.width - 10 });
      } else {
        text(doc, values[column.key], x + 5, y + 5, { size: 8.5, width: column.width - 10, align: column.align, font: column.key === "amount" ? "semibold" : "regular" });
      }
      x += column.width;
    }
    y += rowHeight;
    doc.moveTo(left, y).lineTo(left + CONTENT, y).lineWidth(0.5).strokeColor(LINE).stroke();
  });

  /* ---------------- totals ---------------- */
  const t = invoice.totals;
  const rows = [];
  rows.push(["Subtotal", money(t.gross)]);
  if (t.discount) rows.push(["Discount", `-${money(t.discount)}`]);
  if (gst) {
    rows.push(["Taxable amount", money(t.taxable)]);
    if (t.cgst) rows.push(["CGST", money(t.cgst)]);
    if (t.sgst) rows.push(["SGST", money(t.sgst)]);
    if (t.igst) rows.push(["IGST", money(t.igst)]);
  }
  if (t.roundOff) rows.push(["Round off", `${t.roundOff > 0 ? "+" : "-"}${money(Math.abs(t.roundOff))}`]);

  const needed = rows.length * 15 + 110;
  if (y + needed > PAGE.height - 60) {
    doc.addPage();
    y = PAGE.margin;
  }
  y += 12;
  const totalsX = left + CONTENT - 230;
  const totalsTop = y;
  for (const [label, value] of rows) {
    text(doc, label, totalsX, y, { size: 9, color: MUTED, width: 120 });
    text(doc, value, totalsX + 110, y, { size: 9, width: 120, align: "right" });
    y += 15;
  }
  y += 4;
  doc.rect(totalsX - 8, y - 3, 238, 26).fill(NAVY);
  text(doc, "Grand Total", totalsX, y + 3, { font: "bold", size: 10.5, color: "#ffffff", width: 120 });
  text(doc, money(t.grandTotal), totalsX + 100, y + 3, { font: "bold", size: 11, color: "#ffffff", width: 130, align: "right" });
  y += 32;
  const paidRows = [["Amount paid", money(invoice.amountPaid || 0)], ["Balance due", balanceDueText(invoice, money)]];
  for (const [label, value] of paidRows) {
    text(doc, label, totalsX, y, { size: 9, color: MUTED, width: 120 });
    // Value starts after the label so "₹0.00 (Invoice cancelled)" fits on one line.
    text(doc, value, totalsX + 60, y, { font: label === "Balance due" ? "bold" : "regular", size: 9, width: 170, align: "right" });
    y += 15;
  }
  const status = { unpaid: "Unpaid", partial: "Partially paid", paid: "Paid" }[invoice.paymentStatus] || "";
  if (status && invoice.status !== "cancelled") {
    text(doc, `Payment status: ${status}`, totalsX, y + 2, { font: "semibold", size: 8.5, color: invoice.paymentStatus === "paid" ? "#1a7f37" : GOLD, width: 230, align: "right" });
    y += 16;
  }

  // Left column beside the totals: amount in words + GST summary.
  let ly = totalsTop;
  text(doc, "Amount in words", left, ly, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.6 });
  ly = text(doc, amountInWords(t.grandTotal), left, doc.y + 2, { size: 9, width: totalsX - left - 30 });

  if (gst && t.taxBreakdown?.length) {
    ly += 10;
    text(doc, "GST summary", left, ly, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.6 });
    ly = doc.y + 3;
    const cols = invoice.taxSnapshot.interState ? ["Rate", "Taxable", "IGST"] : ["Rate", "Taxable", "CGST", "SGST"];
    const w = (totalsX - left - 30) / cols.length;
    cols.forEach((c, i) => text(doc, c, left + i * w, ly, { font: "semibold", size: 8, width: w - 4, align: i ? "right" : "left" }));
    ly += 13;
    for (const row of t.taxBreakdown) {
      const values = invoice.taxSnapshot.interState
        ? [`${row.rate}%`, money(row.taxable), money(row.igst)]
        : [`${row.rate}%`, money(row.taxable), money(row.cgst), money(row.sgst)];
      values.forEach((v, i) => text(doc, v, left + i * w, ly, { size: 8, width: w - 4, align: i ? "right" : "left" }));
      ly += 12;
    }
    if (invoice.taxSnapshot.pricesIncludeTax) {
      ly = text(doc, "Prices are inclusive of GST.", left, ly + 2, { size: 7.5, color: MUTED });
    }
  }

  y = Math.max(y, ly) + 18;

  /* ---------------- payments, terms ---------------- */
  const blocks = [];
  const activePayments = (invoice.payments || []).filter(p => p.status !== "void");
  if (activePayments.length) {
    blocks.push(["Payments received", activePayments.map(p => `${invoiceDate(p.date)}  ·  ${PAYMENT_METHODS[p.method] || p.method}  ·  ${money(p.amount)}${p.reference ? `  ·  Ref ${p.reference}` : ""}`).join("\n")]);
  }
  if (invoice.paymentDetails) blocks.push(["Payment details", invoice.paymentDetails]);
  if (invoice.notes) blocks.push(["Notes", invoice.notes]);
  // Owner-written terms from Settings sit alongside the standard terms below.
  if (invoice.terms) blocks.push(["Additional terms", invoice.terms]);
  if (invoice.replaces) blocks.push(["Replaces", `This invoice replaces cancelled invoice ${invoice.replaces.invoiceNo}.`]);

  for (const [title, body] of blocks) {
    doc.font("regular").fontSize(8.5);
    const h = doc.heightOfString(body, { width: CONTENT, lineGap: 1.5 }) + 20;
    if (y + h > PAGE.height - 60) {
      doc.addPage();
      y = PAGE.margin;
    }
    text(doc, title.toUpperCase(), left, y, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.6 });
    y = text(doc, body, left, doc.y + 2, { size: 8.5, width: CONTENT }) + 10;
  }

  /* ---------------- standard terms + closing line ----------------
     Kept together on the final page: if they do not fit below the
     content, both move to a new page instead of splitting. */
  const terms = invoiceTermsFor(invoice);
  const termsWidth = Math.min(CONTENT, 330);
  const closingTop = PAGE.height - 70; // just above the footer rule
  let termsHeight = 0;
  if (terms) {
    doc.font("bold").fontSize(10);
    termsHeight = 22 + doc.heightOfString(terms.headline, { width: CONTENT, lineGap: 1.5 }) + 8;
    doc.font("regular").fontSize(9);
    for (const line of terms.lines) termsHeight += doc.heightOfString(line, { width: termsWidth, lineGap: 1.5 }) + 3;
  }
  if (y + 12 + termsHeight + 24 > closingTop) {
    doc.addPage();
    y = PAGE.margin;
  }
  if (terms) {
    y += 12;
    text(doc, terms.title.toUpperCase(), left, y, { font: "bold", size: 10.5, color: NAVY, characterSpacing: 0.4, width: CONTENT });
    y = text(doc, terms.headline, left, doc.y + 6, { font: "bold", size: 10, color: GOLD_TEXT, width: CONTENT }) + 6;
    for (const line of terms.lines) y = text(doc, line, left, y, { size: 9, width: termsWidth }) + 3;
  }
  text(doc, INVOICE_THANK_YOU, left, Math.max(y + 16, closingTop), { font: "semibold", size: 10, color: NAVY, width: CONTENT, align: "center" });

  /* ---------------- footer on every page ---------------- */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would otherwise make pdfkit add a page.
    doc.page.margins.bottom = 0;
    const fy = PAGE.height - 34;
    doc.moveTo(left, fy - 6).lineTo(left + CONTENT, fy - 6).lineWidth(0.5).strokeColor(LINE).stroke();
    text(doc, `This is a computer-generated ${invoice.documentTitle.toLowerCase()}.  ·  ${seller.businessName}`, left, fy, { size: 7.5, color: MUTED, width: CONTENT - 80, lineBreak: false });
    text(doc, `Page ${i - range.start + 1} of ${range.count}`, left + CONTENT - 80, fy, { size: 7.5, color: MUTED, width: 80, align: "right", lineBreak: false });
  }
}
