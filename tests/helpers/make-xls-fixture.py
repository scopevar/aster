"""Reproduce the independent BIFF8 fixture with xlwt 1.3.0 (BSD).

Source: https://pypi.org/project/xlwt/1.3.0/
This authoring tool is optional; tests consume the checked-in bytes and never use
SheetJS to write the file they subsequently read. No Python dependency ships.
"""
from pathlib import Path
import sys

if len(sys.argv) > 1:
    sys.path.insert(0, sys.argv[1])
import xlwt

book = xlwt.Workbook()
sheet = book.add_sheet("独立公式")
sheet.write(0, 0, "BIFF8_真实公式")
sheet.write(1, 0, 0)
sheet.write(1, 1, 42)
sheet.write(1, 2, xlwt.Formula("A2+B2"))
sheet.write(2, 0, "第一行\n第二行")
book.add_sheet("第二表").write(0, 0, "另一张表")
target = Path(__file__).resolve().parent.parent / "fixtures" / "independent-formula.xls"
target.parent.mkdir(exist_ok=True)
book.save(str(target))
