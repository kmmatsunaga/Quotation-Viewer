import win32com.client, os

pptx_path = r"C:\Users\matsunaga\Claude-Code-Test\Quotation-Viewer\Claude_Code_Work.pptx"
out_dir = r"C:\Users\matsunaga\Claude-Code-Test\Quotation-Viewer\slides_img"
os.makedirs(out_dir, exist_ok=True)

app = win32com.client.Dispatch("PowerPoint.Application")
app.Visible = 1
prs = app.Presentations.Open(pptx_path, ReadOnly=1, Untitled=0, WithWindow=0)
for i, slide in enumerate(prs.Slides):
    out_path = os.path.join(out_dir, f"slide-{i+1}.jpg")
    slide.Export(out_path, "JPG", 1280, 720)
    print("Saved:", out_path)
prs.Close()
app.Quit()
