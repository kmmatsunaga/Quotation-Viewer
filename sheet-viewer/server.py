import http.server
import socketserver
import os

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

with socketserver.TCPServer(("", PORT), http.server.SimpleHTTPRequestHandler) as httpd:
    print(f"サーバー起動中: http://localhost:{PORT}")
    print("停止するには Ctrl+C")
    httpd.serve_forever()
