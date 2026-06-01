"""Generate Scent World Canada — Google Business Profile Work Brief PDF for Emmaculate"""
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch, cm
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    Table, TableStyle, ListFlowable, ListItem, HRFlowable, KeepTogether
)
from reportlab.pdfgen import canvas

# Brand colors
GOLD = colors.HexColor('#c9a55c')
GOLD_LIGHT = colors.HexColor('#e0ca8e')
DARK_BG = colors.HexColor('#0b0908')
DARK_BG2 = colors.HexColor('#1a1714')
CREAM = colors.HexColor('#f5f0e6')
TEXT_DARK = colors.HexColor('#2d2620')
TEXT_GRAY = colors.HexColor('#666666')
LIGHT_BG = colors.HexColor('#f9f5ef')
BORDER = colors.HexColor('#e5dcc8')

OUTPUT = "Scent_World_Google_Business_Profile_Work_Brief.pdf"

def header_footer(canvas_obj, doc):
    """Add header and footer to every page"""
    canvas_obj.saveState()
    width, height = letter
    # Header bar
    canvas_obj.setFillColor(DARK_BG)
    canvas_obj.rect(0, height - 0.5*inch, width, 0.5*inch, stroke=0, fill=1)
    # Gold accent line
    canvas_obj.setFillColor(GOLD)
    canvas_obj.rect(0, height - 0.52*inch, width, 0.02*inch, stroke=0, fill=1)
    # Header text
    canvas_obj.setFillColor(GOLD)
    canvas_obj.setFont("Times-Bold", 12)
    canvas_obj.drawString(0.6*inch, height - 0.32*inch, "SCENT WORLD CANADA")
    canvas_obj.setFillColor(CREAM)
    canvas_obj.setFont("Helvetica", 9)
    canvas_obj.drawRightString(width - 0.6*inch, height - 0.32*inch, "Google Business Profile Brief")
    # Footer
    canvas_obj.setFillColor(TEXT_GRAY)
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.drawString(0.6*inch, 0.4*inch, "Confidential — Scent World Canada")
    canvas_obj.drawCentredString(width/2, 0.4*inch, "scentworld.ca  ·  (902) 707-0807  ·  info@scentworld.ca")
    canvas_obj.drawRightString(width - 0.6*inch, 0.4*inch, f"Page {doc.page}")
    canvas_obj.restoreState()

styles = getSampleStyleSheet()

# Custom styles
title_style = ParagraphStyle(
    'TitleCustom', parent=styles['Title'],
    fontName='Times-Bold', fontSize=28, leading=34,
    textColor=GOLD, alignment=TA_CENTER, spaceAfter=8
)
subtitle_style = ParagraphStyle(
    'SubtitleCustom', parent=styles['Normal'],
    fontName='Times-Italic', fontSize=14, leading=18,
    textColor=TEXT_DARK, alignment=TA_CENTER, spaceAfter=20
)
h1_style = ParagraphStyle(
    'H1Custom', parent=styles['Heading1'],
    fontName='Times-Bold', fontSize=20, leading=26,
    textColor=GOLD, spaceBefore=18, spaceAfter=10,
    borderPadding=0
)
h2_style = ParagraphStyle(
    'H2Custom', parent=styles['Heading2'],
    fontName='Times-Bold', fontSize=14, leading=18,
    textColor=DARK_BG, spaceBefore=14, spaceAfter=8
)
h3_style = ParagraphStyle(
    'H3Custom', parent=styles['Heading3'],
    fontName='Helvetica-Bold', fontSize=11, leading=15,
    textColor=GOLD, spaceBefore=10, spaceAfter=4,
    letterSpacing=2
)
body_style = ParagraphStyle(
    'BodyCustom', parent=styles['Normal'],
    fontName='Helvetica', fontSize=10, leading=15,
    textColor=TEXT_DARK, spaceAfter=8, alignment=TA_JUSTIFY
)
body_small = ParagraphStyle(
    'BodySmall', parent=styles['Normal'],
    fontName='Helvetica', fontSize=9, leading=13,
    textColor=TEXT_DARK, spaceAfter=6
)
bullet_style = ParagraphStyle(
    'BulletCustom', parent=styles['Normal'],
    fontName='Helvetica', fontSize=10, leading=15,
    textColor=TEXT_DARK, leftIndent=20, spaceAfter=4
)
code_style = ParagraphStyle(
    'CodeCustom', parent=styles['Code'],
    fontName='Courier', fontSize=9, leading=12,
    textColor=TEXT_DARK, backColor=LIGHT_BG,
    borderColor=GOLD, borderWidth=0.5, borderPadding=8,
    leftIndent=10, rightIndent=10, spaceAfter=12, spaceBefore=6
)
checkbox_style = ParagraphStyle(
    'Checkbox', parent=styles['Normal'],
    fontName='Helvetica', fontSize=10, leading=15,
    textColor=TEXT_DARK, leftIndent=15, spaceAfter=3
)
quote_style = ParagraphStyle(
    'Quote', parent=styles['Normal'],
    fontName='Times-Italic', fontSize=10, leading=15,
    textColor=TEXT_DARK, leftIndent=18, rightIndent=18,
    spaceAfter=8, spaceBefore=4,
    backColor=LIGHT_BG, borderColor=GOLD, borderWidth=0,
    borderPadding=10
)
note_style = ParagraphStyle(
    'Note', parent=styles['Normal'],
    fontName='Helvetica-Oblique', fontSize=9, leading=13,
    textColor=TEXT_GRAY, spaceAfter=8
)

story = []

# ═══════════ COVER PAGE ═══════════
story.append(Spacer(1, 1.2*inch))
story.append(Paragraph("SCENT WORLD CANADA", ParagraphStyle(
    'CoverBrand', parent=styles['Normal'],
    fontName='Times-Bold', fontSize=14, leading=20,
    textColor=GOLD, alignment=TA_CENTER, spaceAfter=4
)))
story.append(Paragraph("LUXURY SCENT MARKETING", ParagraphStyle(
    'CoverTag', parent=styles['Normal'],
    fontName='Helvetica', fontSize=9, leading=14,
    textColor=TEXT_GRAY, alignment=TA_CENTER, spaceAfter=40
)))
story.append(HRFlowable(width="40%", thickness=1, color=GOLD,
                        spaceAfter=20, hAlign='CENTER'))
story.append(Paragraph("Google Business Profile", title_style))
story.append(Paragraph("Work Brief &amp; Step-by-Step Guide", subtitle_style))
story.append(HRFlowable(width="40%", thickness=1, color=GOLD,
                        spaceAfter=30, hAlign='CENTER'))

cover_info = [
    ["<b>Assigned to:</b>", "Emmaculate"],
    ["<b>Prepared by:</b>", "AJ — Scent World Canada"],
    ["<b>Estimated time:</b>", "2–3 hours initial + ongoing 15 min/week"],
    ["<b>Login URL:</b>", "https://business.google.com"],
    ["<b>Support contact:</b>", "(902) 707-0807"],
]
cover_table_data = [[Paragraph(k, body_style), Paragraph(v, body_style)] for k, v in cover_info]
cover_table = Table(cover_table_data, colWidths=[1.8*inch, 4*inch])
cover_table.setStyle(TableStyle([
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ('TOPPADDING', (0,0), (-1,-1), 8),
    ('BACKGROUND', (0,0), (-1,-1), LIGHT_BG),
    ('LINEBELOW', (0,0), (-1,-2), 0.5, BORDER),
    ('LEFTPADDING', (0,0), (-1,-1), 16),
    ('RIGHTPADDING', (0,0), (-1,-1), 16),
]))
story.append(cover_table)
story.append(Spacer(1, 0.8*inch))

intro_para = ("This document is your complete work brief. Everything is pre-written — "
              "just copy and paste exactly what is provided. Follow the tasks in order. "
              "Tasks 1-4 should be completed in Week 1. The remaining tasks are weekly "
              "post schedules spread over 8 weeks plus ongoing maintenance.")
story.append(Paragraph(intro_para, ParagraphStyle(
    'Intro', parent=body_style, alignment=TA_CENTER,
    fontSize=10, textColor=TEXT_GRAY, leftIndent=30, rightIndent=30
)))

story.append(PageBreak())

# ═══════════ TABLE OF CONTENTS ═══════════
story.append(Paragraph("Table of Contents", h1_style))
story.append(Spacer(1, 6))

toc_data = [
    ["Section", "Page"],
    ["Quick Overview &amp; Schedule", "3"],
    ["Task 1: Update Business Description", "4"],
    ["Task 2: Add Services (8 services)", "4"],
    ["Task 3: Add Products with Prices (13 products)", "5"],
    ["Task 4: Set Up Profile Attributes", "6"],
    ["Tasks 5-12: 8-Week Google Posts Schedule", "7"],
    ["Task 13: Photo Upload Schedule", "11"],
    ["Task 14: Ongoing Weekly Engagement", "11"],
    ["Success Metrics &amp; Reporting", "12"],
    ["Rules &amp; Restrictions", "12"],
    ["Master Checklist", "13"],
]
toc_table = Table(toc_data, colWidths=[4.5*inch, 1*inch])
toc_table.setStyle(TableStyle([
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('BACKGROUND', (0,0), (-1,0), DARK_BG),
    ('TEXTCOLOR', (0,0), (-1,0), GOLD),
    ('FONTNAME', (0,1), (-1,-1), 'Helvetica'),
    ('FONTSIZE', (0,0), (-1,-1), 10),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('TOPPADDING', (0,0), (-1,-1), 7),
    ('BOTTOMPADDING', (0,0), (-1,-1), 7),
    ('LEFTPADDING', (0,0), (-1,-1), 12),
    ('LINEBELOW', (0,0), (-1,-1), 0.5, BORDER),
    ('TEXTCOLOR', (1,1), (1,-1), GOLD),
    ('ALIGN', (1,0), (1,-1), 'CENTER'),
]))
story.append(toc_table)

story.append(PageBreak())

# ═══════════ OVERVIEW ═══════════
story.append(Paragraph("Quick Overview", h1_style))
story.append(Paragraph(
    "This brief is organized into 14 tasks. The first 4 are one-time setup tasks "
    "to be completed in Week 1. Tasks 5-12 are weekly Google Posts (one per week for 8 weeks). "
    "Tasks 13-14 are ongoing maintenance activities. The full master checklist is at the end.",
    body_style
))

story.append(Paragraph("8-Week Schedule at a Glance", h2_style))
schedule_data = [
    ["Week", "Activities"],
    ["Week 1", "Setup tasks 1-4 + Post #1 (Launch Announcement) + Upload 5 photos"],
    ["Week 2", "Post #2 (For Hotels) + 2 new photos + Reply to all reviews"],
    ["Week 3", "Post #3 (For Spas) + 2 new photos + Reply to all reviews"],
    ["Week 4", "Post #4 (For Restaurants) + 2 new photos + Reply to all reviews"],
    ["Week 5", "Post #5 (Custom Signature Scents) + 2 new photos + Reply to reviews"],
    ["Week 6", "Post #6 (Customer Trust Builder) + 2 new photos + Reply to reviews"],
    ["Week 7", "Post #7 (Educational/Blog) + 2 new photos + Reply to reviews"],
    ["Week 8", "Post #8 (Free Shipping Offer) + 2 new photos + Reply to reviews"],
]
sched_table = Table(schedule_data, colWidths=[0.8*inch, 4.7*inch])
sched_table.setStyle(TableStyle([
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('BACKGROUND', (0,0), (-1,0), DARK_BG),
    ('TEXTCOLOR', (0,0), (-1,0), GOLD),
    ('FONTNAME', (0,1), (-1,-1), 'Helvetica'),
    ('FONTSIZE', (0,0), (-1,-1), 9),
    ('FONTNAME', (0,1), (0,-1), 'Helvetica-Bold'),
    ('TEXTCOLOR', (0,1), (0,-1), GOLD),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('TOPPADDING', (0,0), (-1,-1), 7),
    ('BOTTOMPADDING', (0,0), (-1,-1), 7),
    ('LEFTPADDING', (0,0), (-1,-1), 12),
    ('LINEBELOW', (0,0), (-1,-1), 0.5, BORDER),
    ('BACKGROUND', (0,1), (-1,-1), LIGHT_BG),
]))
story.append(sched_table)

story.append(PageBreak())

# ═══════════ TASK 1 ═══════════
story.append(Paragraph("Task 1 — Update Business Description", h1_style))
story.append(Paragraph("Time required: ~5 minutes &nbsp;&nbsp;|&nbsp;&nbsp; Frequency: One-time", note_style))

story.append(Paragraph("Where to go", h3_style))
story.append(Paragraph(
    "Edit Profile &rarr; About section &rarr; Business description field",
    body_style
))

story.append(Paragraph("Steps", h3_style))
steps_t1 = [
    "Click <b>Edit profile</b>",
    "Navigate to the <b>About</b> section",
    "Find the <b>Business description</b> field",
    "Delete any existing text",
    "Copy the description below exactly as shown",
    "Paste into the field",
    "Click <b>Save</b>",
    "Verify the description appears on your public business profile",
]
for s in steps_t1:
    story.append(Paragraph(f"&#9744; &nbsp;{s}", checkbox_style))

story.append(Paragraph("Description to copy and paste", h3_style))
description_text = ("Scent World Canada is Atlantic Canada's premier scent marketing company, "
    "delivering luxury fragrance solutions to hotels, spas, restaurants, retail spaces, "
    "offices and discerning homes across the country. Based in Halifax, we specialize "
    "in commercial scent diffusers, signature fragrance oils, custom scent strategy, "
    "and HVAC-integrated diffusion systems for brands that understand atmosphere is "
    "the most powerful (and overlooked) part of guest experience. From boutique inn "
    "lobbies to spa relaxation rooms and fine dining ambiance — our cold-air "
    "nano-diffusion technology transforms ordinary spaces into unforgettable sensory "
    "destinations. Free shipping over $150 across Canada. Book your free 30-minute "
    "scent strategy consultation today.")
story.append(Paragraph(description_text, quote_style))

# ═══════════ TASK 2 ═══════════
story.append(Paragraph("Task 2 — Add Services", h1_style))
story.append(Paragraph("Time required: ~15 minutes &nbsp;&nbsp;|&nbsp;&nbsp; Frequency: One-time", note_style))

story.append(Paragraph("Where to go", h3_style))
story.append(Paragraph("Edit Profile &rarr; Services tab &rarr; Click <b>Add a service</b>", body_style))

story.append(Paragraph("Add each of these 8 services:", h3_style))

services_data = [
    ["#", "Service Name", "Description"],
    ["1", "Hotel Lobby Scent Marketing",
     "Custom signature scents and professional diffusion systems for hotel lobbies, suites, and common areas."],
    ["2", "Spa Aromatherapy Design",
     "Therapy-supportive scenting for spas, wellness centres, treatment rooms, and relaxation lounges."],
    ["3", "Restaurant Ambient Scenting",
     "Calibrated scent strategies for fine dining, casual restaurants, cafés, and bars."],
    ["4", "Custom Signature Scent Development",
     "Bespoke fragrance design unique to your brand identity. Trademark-protectable."],
    ["5", "Commercial Diffusion Equipment",
     "Cold-air nano-diffusion systems, HVAC-integrated solutions, and zone-controlled deployment."],
    ["6", "Scent Strategy Consultation",
     "Complimentary 30-minute consultation to design your fragrance approach."],
    ["7", "Office and Workplace Scenting",
     "Productivity-boosting workplace fragrance programs."],
    ["8", "Subscription Fragrance Refills",
     "Auto-delivered fragrance oils and supplies. Set it and forget it."],
]
services_para_data = [[
    Paragraph(f"<b>{r[0]}</b>", body_small) if i == 0 else Paragraph(r[0], body_small),
    Paragraph(f"<b>{r[1]}</b>" if i == 0 else r[1], body_small),
    Paragraph(f"<b>{r[2]}</b>" if i == 0 else r[2], body_small)
] for i, r in enumerate(services_data)]

services_table = Table(services_para_data, colWidths=[0.4*inch, 1.8*inch, 3.3*inch])
services_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), DARK_BG),
    ('TEXTCOLOR', (0,0), (-1,0), GOLD),
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('TOPPADDING', (0,0), (-1,-1), 6),
    ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ('LEFTPADDING', (0,0), (-1,-1), 8),
    ('RIGHTPADDING', (0,0), (-1,-1), 8),
    ('LINEBELOW', (0,0), (-1,-1), 0.4, BORDER),
    ('GRID', (0,0), (-1,-1), 0.3, BORDER),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, LIGHT_BG]),
]))
story.append(services_table)
story.append(Paragraph("After all 8 services added, click <b>Save</b>.", body_style))

story.append(PageBreak())

# ═══════════ TASK 3 ═══════════
story.append(Paragraph("Task 3 — Add Products with Prices", h1_style))
story.append(Paragraph("Time required: ~30 minutes &nbsp;&nbsp;|&nbsp;&nbsp; Frequency: One-time", note_style))

story.append(Paragraph("Where to go", h3_style))
story.append(Paragraph("Edit Profile &rarr; Products tab &rarr; Click <b>Add product</b>", body_style))

story.append(Paragraph("Steps for each product", h3_style))
prod_steps = [
    "Click <b>Add product</b>",
    "Upload product photo (from shared folder/drive)",
    "Enter Product name (exact text from table below)",
    "Enter Price in CAD",
    "Paste Description",
    "Click <b>Save</b> &rarr; Repeat for next product",
]
for s in prod_steps:
    story.append(Paragraph(f"&#9744; &nbsp;{s}", checkbox_style))

story.append(Spacer(1, 8))
story.append(Paragraph("Products to add (13 total)", h3_style))

products_data = [
    ["#", "Product Name", "Price (CAD)", "Description"],
    ["1", "S20 Nano Diffuser", "$199", "Compact nano diffuser for personal spaces up to 300 sq ft."],
    ["2", "S30 Nano Diffuser", "$349", "Mid-size nano diffuser with programmable timer. Coverage up to 2,870 sq ft."],
    ["3", "S100 Commercial Diffuser", "$599", "Professional-grade cold-air diffuser for commercial spaces up to 3,230 sq ft."],
    ["4", "S200 Commercial Diffuser", "$899", "High-capacity nano diffuser for large commercial environments up to 17,945 sq ft."],
    ["5", "L100 Luxury Diffuser", "$749", "Premium luxury diffuser with elegant design and smart controls."],
    ["6", "L200 Luxury Diffuser", "$1,299", "Top-tier luxury diffuser with diamond-pattern design for premium venues."],
    ["7", "Car Scent Diffuser", "$149", "Premium car diffuser with USB-C power and nano mist technology."],
    ["8", "Car Diffuser Gift Set", "$249", "Car diffuser with 5 curated fragrance oils in luxury packaging."],
    ["9", "Fresh Blossom Fragrance Oil", "$49", "Light floral blend with notes of spring blossoms and green leaves."],
    ["10", "White Tea Fragrance Oil", "$49", "Clean, calming white tea fragrance perfect for spas and wellness spaces."],
    ["11", "Oud Fragrance Oil", "$59", "Rich, warm oud blend — a signature Middle Eastern luxury fragrance."],
    ["12", "Vienna Fragrance Oil", "$49", "Sophisticated European-inspired blend with warm amber undertones."],
    ["13", "Spark Honey Fragrance Oil", "$49", "Sweet and vibrant honey-citrus blend for energizing spaces."],
]
products_para_data = [[
    Paragraph(f"<b>{c}</b>" if r_idx == 0 else c, body_small)
    for c in r
] for r_idx, r in enumerate(products_data)]
products_table = Table(products_para_data, colWidths=[0.3*inch, 1.6*inch, 0.7*inch, 2.9*inch])
products_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), DARK_BG),
    ('TEXTCOLOR', (0,0), (-1,0), GOLD),
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('TOPPADDING', (0,0), (-1,-1), 5),
    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ('LEFTPADDING', (0,0), (-1,-1), 6),
    ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ('GRID', (0,0), (-1,-1), 0.3, BORDER),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, LIGHT_BG]),
    ('TEXTCOLOR', (2,1), (2,-1), GOLD),
    ('FONTNAME', (2,1), (2,-1), 'Helvetica-Bold'),
]))
story.append(products_table)

story.append(PageBreak())

# ═══════════ TASK 4 ═══════════
story.append(Paragraph("Task 4 — Set Up Profile Attributes", h1_style))
story.append(Paragraph("Time required: ~10 minutes &nbsp;&nbsp;|&nbsp;&nbsp; Frequency: One-time", note_style))

story.append(Paragraph("Where to go", h3_style))
story.append(Paragraph("Edit Profile &rarr; <b>More</b> &rarr; scroll to <b>Attributes</b>", body_style))

story.append(Paragraph("Toggle ON these attributes:", h3_style))

attributes_data = [
    ["Status", "Attribute", "Notes"],
    ["ON", "Online appointments", "Yes — we have a booking form"],
    ["ON", "Online estimates", "Yes — we have a quote form"],
    ["ON", "LGBTQ+ friendly", "Yes"],
    ["ON", "Accepts credit cards", "Yes — via Stripe"],
    ["ON", "Accepts mobile payments", "Yes — Apple Pay, Google Pay via Stripe"],
    ["ASK AJ", "Identifies as woman-owned", "Confirm with AJ before enabling"],
    ["ASK AJ", "Wheelchair accessible", "Confirm with AJ if office is accessible"],
]
attr_para_data = [[
    Paragraph(f"<b>{c}</b>" if r_idx == 0 else c, body_small)
    for c in r
] for r_idx, r in enumerate(attributes_data)]
attr_table = Table(attr_para_data, colWidths=[0.9*inch, 2.0*inch, 2.6*inch])
attr_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), DARK_BG),
    ('TEXTCOLOR', (0,0), (-1,0), GOLD),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('TOPPADDING', (0,0), (-1,-1), 6),
    ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ('LEFTPADDING', (0,0), (-1,-1), 8),
    ('GRID', (0,0), (-1,-1), 0.3, BORDER),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, LIGHT_BG]),
    ('FONTNAME', (0,1), (0,-1), 'Helvetica-Bold'),
    ('TEXTCOLOR', (0,1), (0,-1), GOLD),
]))
story.append(attr_table)
story.append(Paragraph("After toggling, click <b>Save changes</b>.", body_style))

story.append(PageBreak())

# ═══════════ TASKS 5-12 - WEEKLY POSTS ═══════════
story.append(Paragraph("Tasks 5–12 — 8-Week Google Posts Schedule", h1_style))
story.append(Paragraph(
    "Create one post per week using the templates below. Go to your Business Profile "
    "dashboard and click <b>Add update</b>. Copy each post text exactly. "
    "Schedule a reminder every Sunday at 7pm to post one update — it takes 90 seconds.",
    body_style
))

# Post template function
def add_post_block(num, title, week, photo, button, action_url, content):
    story.append(Paragraph(f"Task {num+4} — Post #{num}: {title}", h2_style))
    story.append(Paragraph(f"Publish in Week {week} &nbsp;&nbsp;|&nbsp;&nbsp; Type: Update", note_style))

    info_data = [
        ["Photo needed:", photo],
        ["Button type:", button],
        ["Button URL:", action_url],
    ]
    info_table_data = [[Paragraph(f"<b>{k}</b>", body_small), Paragraph(v, body_small)] for k, v in info_data]
    info_table = Table(info_table_data, colWidths=[1.2*inch, 4.3*inch])
    info_table.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BACKGROUND', (0,0), (-1,-1), LIGHT_BG),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('LINEBELOW', (0,0), (-1,-1), 0.3, BORDER),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 6))
    story.append(Paragraph("<b>Copy and paste this exact text:</b>", body_small))
    story.append(Paragraph(content.replace('\n', '<br/>'), quote_style))
    story.append(Spacer(1, 8))

# Post 1
add_post_block(1, "Launch Announcement", 1,
    "Hero/luxury lobby image (use website hero or product photo)",
    "Learn more", "https://www.scentworld.ca",
    """✨ Now Serving Atlantic Canada ✨

Scent World Canada brings premium scent marketing to hotels, spas, restaurants, and luxury homes across Canada.

🌿 Custom signature scents
🏨 Commercial diffusion systems
🚚 Free shipping over $150
🌟 Rated 5/5 by 18+ clients

Book your free 30-minute scent consultation today.""")

# Post 2
add_post_block(2, "For Hotels", 2,
    "Hotel lobby image",
    "Book", "https://www.scentworld.ca/#booking",
    """🏨 HOTEL OWNERS — Did you know?

Studies show signature lobby scents increase guest satisfaction by 20% and dwell time by 33%.

Your competitors who invested in scent marketing are already winning repeat bookings. Don't get left behind.

Schedule a complimentary 30-min consultation:
📞 (902) 707-0807
🌐 scentworld.ca""")

# Post 3
add_post_block(3, "For Spas", 3,
    "Spa interior / treatment room",
    "Learn more", "https://www.scentworld.ca/industries/spas.html",
    """🧘 SPA OWNERS

Your treatment is what clients pay for.
Your ATMOSPHERE is what makes them return.

Professional aromatherapy systems for:
✓ Reception areas
✓ Treatment rooms
✓ Relaxation lounges
✓ Wet zones

Cold-air diffusion. Zero residue. Whisper-quiet.

Book your free space assessment today.""")

# Post 4
add_post_block(4, "For Restaurants", 4,
    "Restaurant interior",
    "Call", "tel:+19027070807",
    """🍽️ RESTAURANT OWNERS

The science is clear:
✓ +38% appetite stimulation
✓ +28% dessert orders
✓ +19% average dwell time

Strategic ambient scenting transforms dining experiences AND drives revenue.

Free consultation: (902) 707-0807""")

# Post 5
add_post_block(5, "Custom Signature Scents", 5,
    "Fragrance bottles / lab image",
    "Book", "https://www.scentworld.ca/#booking",
    """🧪 BESPOKE SIGNATURE SCENTS

The same scent design process used by the Westin, Ritz-Carlton, and Singapore Airlines — now available to Canadian boutique brands.

Our master blenders create a unique fragrance that becomes your brand's most intimate handshake.

Reserve your scent strategy consultation:
🌐 scentworld.ca""")

# Post 6
add_post_block(6, "Customer Trust Builder", 6,
    "SW Gold logo or 5-star graphic",
    "Learn more", "Google Reviews link",
    """🌟 18+ Five-Star Reviews

"Working with Scent World Canada transformed our lobby into an unforgettable sensory experience..."
— Hotel General Manager

"The custom scent for our spa perfectly captures the calm we wanted..."
— Wellness Centre Owner

Read all reviews on Google ⭐⭐⭐⭐⭐""")

# Post 7
add_post_block(7, "Educational / Blog Promotion", 7,
    "Diffuser or oils close-up",
    "Learn more", "https://www.scentworld.ca/blog.html",
    """📚 NEW ON OUR JOURNAL

"The Science of Scent Marketing: How Aroma Drives Customer Behaviour"

Research shows scent can:
• Boost purchase intent by 80%
• Increase dwell time by 44%
• Improve memory recall by 65%

Read the full article → scentworld.ca/blog""")

# Post 8 - Offer type
story.append(Paragraph("Task 12 — Post #8: Free Shipping Offer", h2_style))
story.append(Paragraph("Publish in Week 8 &nbsp;&nbsp;|&nbsp;&nbsp; Type: <b>OFFER</b> (not Update)", note_style))
post8_info = [
    ["Photo needed:", "Product lineup"],
    ["Button type:", "Order online"],
    ["Button URL:", "https://www.scentworld.ca/#products"],
]
p8_table = Table([[Paragraph(f"<b>{k}</b>", body_small), Paragraph(v, body_small)] for k, v in post8_info],
                 colWidths=[1.2*inch, 4.3*inch])
p8_table.setStyle(TableStyle([
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('BACKGROUND', (0,0), (-1,-1), LIGHT_BG),
    ('TOPPADDING', (0,0), (-1,-1), 5),
    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ('LEFTPADDING', (0,0), (-1,-1), 10),
    ('RIGHTPADDING', (0,0), (-1,-1), 10),
    ('LINEBELOW', (0,0), (-1,-1), 0.3, BORDER),
]))
story.append(p8_table)
story.append(Spacer(1, 6))
story.append(Paragraph("<b>Copy and paste this exact text:</b>", body_small))
post8_content = """🚚 FREE SHIPPING ACROSS CANADA

On all orders over $150.

Premium diffusers from $199.
Bespoke fragrance oils from $49.
Commercial systems available.

Coast-to-coast delivery in 3-8 business days.
Tracked. Insured. Guaranteed.

Shop: scentworld.ca"""
story.append(Paragraph(post8_content.replace('\n', '<br/>'), quote_style))

story.append(PageBreak())

# ═══════════ TASK 13 ═══════════
story.append(Paragraph("Task 13 — Photo Upload Schedule", h1_style))
story.append(Paragraph(
    "Google ranks businesses with photos posted in the last 30 days higher in local results. "
    "Keep uploading consistently.", body_style))

story.append(Paragraph("Where to go", h3_style))
story.append(Paragraph("Business Profile &rarr; <b>Photos</b> &rarr; click <b>Add photos</b>", body_style))

story.append(Paragraph("Upload schedule", h3_style))
photo_sched = [
    "<b>Week 1:</b> Upload 5 product photos from shared folder",
    "<b>Week 2:</b> Upload 2 lifestyle photos (lobby/spa atmosphere)",
    "<b>Week 3:</b> Upload 2 more product photos",
    "<b>Week 4:</b> Upload 2 behind-the-scenes photos (packaging orders, workspace)",
    "<b>Week 5:</b> Upload 2 customer installation photos (with written permission only)",
    "<b>Ongoing:</b> Add at least 2 photos every 2 weeks to stay active",
]
for p in photo_sched:
    story.append(Paragraph(f"&#9744; &nbsp;{p}", checkbox_style))

story.append(Paragraph("Photo categories Google likes most", h3_style))
photo_cats = [
    "<b>Cover photo</b> (1080×608 px) — Hero/lobby vibe",
    "<b>Interior</b> — workspace photos",
    "<b>Products</b> — 20 already uploaded ✓",
    "<b>At work</b> — packaging orders, prep, installations",
]
for p in photo_cats:
    story.append(Paragraph(f"• {p}", bullet_style))

# ═══════════ TASK 14 ═══════════
story.append(Paragraph("Task 14 — Ongoing Weekly Engagement", h1_style))
story.append(Paragraph("Time required: ~15 minutes per week &nbsp;&nbsp;|&nbsp;&nbsp; Frequency: Weekly", note_style))

story.append(Paragraph("Every Monday", h3_style))
mon_tasks = [
    "Reply to ALL new reviews — even 5-star ones (say <b>Thank you!</b>)",
    "Check for new customer questions on profile &rarr; answer within 24 hours",
    "Update <b>Hours</b> if any holiday closures are coming up",
]
for t in mon_tasks:
    story.append(Paragraph(f"&#9744; &nbsp;{t}", checkbox_style))

story.append(Paragraph("Every Friday", h3_style))
fri_tasks = [
    "Post one Google Post (rotate through Posts 1-8)",
    "Upload at least 1 new photo to keep listing fresh",
]
for t in fri_tasks:
    story.append(Paragraph(f"&#9744; &nbsp;{t}", checkbox_style))

story.append(PageBreak())

# ═══════════ SUCCESS METRICS ═══════════
story.append(Paragraph("Success Metrics &amp; Reporting", h1_style))
story.append(Paragraph(
    "Track these metrics on your Business Profile dashboard &rarr; <b>Performance</b>. "
    "Report numbers to AJ at the end of each month.", body_style))

metrics_data = [
    ["Metric", "Where to find it", "Goal (after 8 weeks)"],
    ["Profile views", "Performance &rarr; Overview", "30-50% increase"],
    ["Direction requests", "Performance &rarr; Searches", "Steady growth"],
    ["Phone calls", "Performance &rarr; Calls", "2-3x more clicks"],
    ["Website clicks", "Performance &rarr; Website", "Steady growth"],
    ["Photo views", "Performance &rarr; Photos", "Growing weekly"],
    ["New reviews", "Reviews tab", "+5-10 reviews/month"],
]
metrics_para_data = [[
    Paragraph(f"<b>{c}</b>" if r_idx == 0 else c, body_small)
    for c in r
] for r_idx, r in enumerate(metrics_data)]
metrics_table = Table(metrics_para_data, colWidths=[1.6*inch, 2.1*inch, 1.8*inch])
metrics_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), DARK_BG),
    ('TEXTCOLOR', (0,0), (-1,0), GOLD),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('TOPPADDING', (0,0), (-1,-1), 6),
    ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ('LEFTPADDING', (0,0), (-1,-1), 8),
    ('GRID', (0,0), (-1,-1), 0.3, BORDER),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, LIGHT_BG]),
]))
story.append(metrics_table)

# ═══════════ RULES ═══════════
story.append(Paragraph("Rules &amp; Restrictions", h1_style))
story.append(Paragraph("<b>What NOT to do:</b>", h3_style))
no_list = [
    "Do <b>not</b> post the same content twice",
    "Do <b>not</b> include prices inside service descriptions (Google may reject)",
    "Do <b>not</b> mention competitor names in any post",
    "Do <b>not</b> post about unrelated topics (politics, news, etc.)",
    "Do <b>not</b> share confidential customer info or photos without written permission",
    "Do <b>not</b> post low-quality or blurry photos",
    "Do <b>not</b> change the business name, address, or phone without confirming with AJ",
]
for x in no_list:
    story.append(Paragraph(f"&#10007; &nbsp;{x}", checkbox_style))

story.append(Paragraph("If you get stuck", h3_style))
stuck_table = [
    ["Login issues", "Contact AJ at (902) 707-0807"],
    ["Don't know what photo to use", "Use any from scentworld.ca — right-click image &rarr; Save Image As"],
    ["Profile says 'needs verification'", "Tell AJ immediately"],
    ["Not sure if a post is approved", "Wait 24 hours — Google reviews each post"],
    ["Negative review received", "Don't respond immediately — notify AJ first"],
]
stuck_para_data = [[Paragraph(f"<b>{r[0]}</b>", body_small), Paragraph(r[1], body_small)] for r in stuck_table]
stuck_table_obj = Table(stuck_para_data, colWidths=[2.0*inch, 3.5*inch])
stuck_table_obj.setStyle(TableStyle([
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('BACKGROUND', (0,0), (-1,-1), LIGHT_BG),
    ('TOPPADDING', (0,0), (-1,-1), 7),
    ('BOTTOMPADDING', (0,0), (-1,-1), 7),
    ('LEFTPADDING', (0,0), (-1,-1), 10),
    ('LINEBELOW', (0,0), (-1,-1), 0.3, BORDER),
]))
story.append(stuck_table_obj)

story.append(PageBreak())

# ═══════════ MASTER CHECKLIST ═══════════
story.append(Paragraph("Master Checklist", h1_style))
story.append(Paragraph("Tick each item as you complete it.", note_style))

checklist_groups = [
    ("Week 1 — Setup Tasks", [
        "Task 1: Business description updated and saved",
        "Task 2: All 8 services added with descriptions",
        "Task 3: All 13 products added with photos and prices",
        "Task 4: All 5 attributes enabled (+ 2 confirmed with AJ)",
        "Task 5: Post #1 (Launch Announcement) published",
        "Uploaded 5 product photos to gallery",
    ]),
    ("Weeks 2-8 — Weekly Posts", [
        "Task 6 (Week 2): Post #2 (For Hotels) published",
        "Task 7 (Week 3): Post #3 (For Spas) published",
        "Task 8 (Week 4): Post #4 (For Restaurants) published",
        "Task 9 (Week 5): Post #5 (Custom Signature Scents) published",
        "Task 10 (Week 6): Post #6 (Trust Builder) published",
        "Task 11 (Week 7): Post #7 (Educational/Blog) published",
        "Task 12 (Week 8): Post #8 (Free Shipping Offer) published",
    ]),
    ("Ongoing Maintenance", [
        "Task 13: Photo uploads every 1-2 weeks (target: 2 photos)",
        "Task 14: Reply to ALL reviews within 24 hours",
        "Task 14: Check and answer customer questions weekly",
        "Task 14: Monthly metrics report sent to AJ",
    ]),
]

for group_name, items in checklist_groups:
    story.append(Paragraph(group_name, h2_style))
    for item in items:
        story.append(Paragraph(f"&#9744; &nbsp;{item}", checkbox_style))
    story.append(Spacer(1, 8))

story.append(Spacer(1, 24))
story.append(HRFlowable(width="100%", thickness=0.5, color=GOLD))
story.append(Spacer(1, 12))
story.append(Paragraph(
    "<b>Thank you, Emmaculate!</b> Your work on our Google Business Profile directly grows our reach, "
    "credibility and incoming inquiries. Every post, photo and review reply makes a real difference. "
    "Questions anytime — just reach out.", body_style))
story.append(Spacer(1, 16))
story.append(Paragraph(
    "<b>Best,</b><br/>AJ<br/>Scent World Canada<br/>(902) 707-0807<br/>info@scentworld.ca",
    body_style))

# ═══════════ BUILD ═══════════
doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=letter,
    leftMargin=0.7*inch,
    rightMargin=0.7*inch,
    topMargin=0.85*inch,
    bottomMargin=0.65*inch,
    title="Scent World Canada — Google Business Profile Work Brief",
    author="Scent World Canada",
    subject="Work Brief for Emmaculate",
)
doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(f"\n✅ PDF generated: {OUTPUT}")
import os
size = os.path.getsize(OUTPUT)
print(f"   File size: {size/1024:.1f} KB")
