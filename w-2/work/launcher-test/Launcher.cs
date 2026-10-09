using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private static volatile bool keepServing = true;

    [STAThread]
    private static void Main()
    {
        try
        {
            string portableRoot = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory,
                "YiJian-data"
            );
            string appRoot = Path.Combine(portableRoot, "app");
            string profileRoot = Path.Combine(portableRoot, "edge-profile");

            ResetLog(portableRoot);
            Log(portableRoot, "launch: " + AppDomain.CurrentDomain.BaseDirectory);

            Directory.CreateDirectory(appRoot);
            Directory.CreateDirectory(profileRoot);
            WriteResource(appRoot, "YiJian.index.html", "index.html");
            WriteResource(appRoot, "YiJian.styles.css", "styles.css");
            WriteResource(appRoot, "YiJian.ai-data.js", "ai-data.js");
            WriteResource(appRoot, "YiJian.app.js", "app.js");
            WriteResource(appRoot, "YiJian.ai-worker-bootstrap.js", "ai-worker-bootstrap.js");
            WriteResource(appRoot, "YiJian.xiangqi-kai.woff2", "xiangqi-kai.woff2");
            Log(portableRoot, "resources written to " + appRoot);

            string edgePath = FindEdge();
            if (edgePath == null)
            {
                Fail(portableRoot, "未找到 Microsoft Edge。请安装 Edge 或 WebView2 Runtime 后重试。");
                return;
            }

            // A plain loopback socket server. HttpListener/HTTP.sys needs a URL
            // reservation and can stall on a machine that has never registered
            // one - which is exactly the "first launch cannot connect" case.
            TcpListener server = new TcpListener(IPAddress.Loopback, 0);
            server.Start();
            int port = ((IPEndPoint)server.LocalEndpoint).Port;
            string url = string.Format("http://127.0.0.1:{0}/index.html?desktop=1", port);
            Log(portableRoot, "server: listening on 127.0.0.1:" + port);

            Thread serverThread = new Thread(delegate() { ServeLoop(server, appRoot); });
            serverThread.IsBackground = true;
            serverThread.Start();

            // Never hand a URL to the browser that we have not served once.
            if (!Probe(url))
            {
                keepServing = false;
                try { server.Stop(); } catch { }
                Fail(portableRoot, "本地服务未就绪，页面可能无法打开。请关闭后重试。");
                return;
            }
            Log(portableRoot, "probe: ok for " + url);

            PrepareProfile(profileRoot);
            Log(portableRoot, "profile ready: " + profileRoot);

            string arguments = string.Format(
                "--app=\"{0}\" --user-data-dir=\"{1}\" --start-maximized "
                    + "--no-first-run --no-default-browser-check --disable-sync",
                url,
                profileRoot
            );

            // TEST BUILD: do not launch a browser, just announce the URL and
            // keep the server up long enough for the harness to fetch a page.
            Console.WriteLine("EDGE " + edgePath);
            Console.WriteLine("ARGS " + arguments);
            Console.WriteLine("READY " + url);
            Console.Out.Flush();
            Thread.Sleep(20000);

            keepServing = false;
            try { server.Stop(); } catch { }
            Log(portableRoot, "exit");
        }
        catch (Exception error)
        {
            try
            {
                Log(
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "YiJian-data"),
                    "error: " + error.Message
                );
            }
            catch
            {
                // Nothing more we can do about logging here.
            }
            MessageBox.Show(
                "启动失败：" + error.Message,
                "弈鉴",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }

    private static void ServeLoop(TcpListener server, string appRoot)
    {
        while (keepServing)
        {
            TcpClient client;
            try
            {
                client = server.AcceptTcpClient();
            }
            catch
            {
                return;
            }
            ThreadPool.QueueUserWorkItem(
                state => HandleClient((TcpClient)state, appRoot),
                client
            );
        }
    }

    private static void HandleClient(TcpClient client, string appRoot)
    {
        try
        {
            client.NoDelay = true;
            using (client)
            using (NetworkStream stream = client.GetStream())
            {
                string requestLine = ReadRequestLine(stream);
                if (requestLine == null)
                {
                    return;
                }

                string path = "/";
                string[] parts = requestLine.Split(' ');
                if (parts.Length >= 2)
                {
                    path = parts[1];
                }
                int query = path.IndexOf('?');
                if (query >= 0)
                {
                    path = path.Substring(0, query);
                }

                string requestPath;
                try
                {
                    requestPath = Uri.UnescapeDataString(path.TrimStart('/'));
                }
                catch
                {
                    requestPath = string.Empty;
                }
                if (requestPath.Length == 0)
                {
                    requestPath = "index.html";
                }

                string filePath = Path.GetFullPath(
                    Path.Combine(appRoot, requestPath.Replace('/', Path.DirectorySeparatorChar))
                );
                string rootPath = Path.GetFullPath(appRoot);

                if (!filePath.StartsWith(rootPath, StringComparison.OrdinalIgnoreCase))
                {
                    WriteResponse(
                        stream,
                        403,
                        "text/plain; charset=utf-8",
                        Encoding.UTF8.GetBytes("Forbidden")
                    );
                    return;
                }
                if (!File.Exists(filePath))
                {
                    WriteResponse(
                        stream,
                        404,
                        "text/plain; charset=utf-8",
                        Encoding.UTF8.GetBytes("Not found")
                    );
                    return;
                }

                WriteResponse(stream, 200, ContentTypeFor(filePath), File.ReadAllBytes(filePath));
            }
        }
        catch
        {
            // The browser closed the socket or the file vanished; nothing to do.
        }
    }

    private static string ReadRequestLine(NetworkStream stream)
    {
        List<byte> buffer = new List<byte>(1024);
        byte[] single = new byte[1];
        while (buffer.Count < 8192)
        {
            int read = stream.Read(single, 0, 1);
            if (read <= 0)
            {
                break;
            }
            buffer.Add(single[0]);
            int count = buffer.Count;
            if (count >= 4
                && buffer[count - 4] == 13
                && buffer[count - 3] == 10
                && buffer[count - 2] == 13
                && buffer[count - 1] == 10)
            {
                break;
            }
        }
        if (buffer.Count == 0)
        {
            return null;
        }
        string text = Encoding.ASCII.GetString(buffer.ToArray());
        int end = text.IndexOf("\r\n", StringComparison.Ordinal);
        return end > 0 ? text.Substring(0, end) : text;
    }

    private static string ContentTypeFor(string filePath)
    {
        string extension = Path.GetExtension(filePath).ToLowerInvariant();
        if (extension == ".html")
        {
            return "text/html; charset=utf-8";
        }
        if (extension == ".css")
        {
            return "text/css; charset=utf-8";
        }
        if (extension == ".js")
        {
            return "text/javascript; charset=utf-8";
        }
        if (extension == ".woff2")
        {
            return "font/woff2";
        }
        return "application/octet-stream";
    }

    private static void WriteResponse(
        NetworkStream stream,
        int status,
        string contentType,
        byte[] body
    )
    {
        string reason = status == 200
            ? "OK"
            : status == 404 ? "Not Found" : status == 403 ? "Forbidden" : "Error";
        StringBuilder header = new StringBuilder();
        header.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
        header.Append("Content-Type: ").Append(contentType).Append("\r\n");
        header.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        header.Append("Cache-Control: no-store\r\n");
        header.Append("Connection: close\r\n\r\n");

        byte[] headerBytes = Encoding.ASCII.GetBytes(header.ToString());
        stream.Write(headerBytes, 0, headerBytes.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    // Confirms the server really answers before the browser is launched.
    private static bool Probe(string url)
    {
        for (int attempt = 0; attempt < 25; attempt += 1)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Proxy = null;
                request.Timeout = 1500;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if ((int)response.StatusCode == 200)
                    {
                        return true;
                    }
                }
            }
            catch
            {
                Thread.Sleep(120);
            }
        }
        return false;
    }

    // Chromium only shows its first-run flow when this marker is missing. On a
    // brand new profile that flow makes the launched process exit early, which
    // used to tear the local server down mid-load.
    private static void PrepareProfile(string profileRoot)
    {
        try
        {
            Directory.CreateDirectory(Path.Combine(profileRoot, "Default"));
            string marker = Path.Combine(profileRoot, "First Run");
            if (!File.Exists(marker))
            {
                File.WriteAllText(marker, string.Empty);
            }
        }
        catch
        {
            // A locked profile is not fatal; Edge recreates what it needs.
        }
    }

    private static void WaitForBrowser(Process edgeProcess, string portableRoot)
    {
        DateTime launchedAt = DateTime.UtcNow;
        if (edgeProcess != null)
        {
            edgeProcess.WaitForExit();
        }

        // The launched process may only be a hand-off stub (typical on a fresh
        // profile, and whenever Edge is already running). Keep the server alive
        // while a real browser window is still up.
        bool exitedEarly = edgeProcess == null
            || DateTime.UtcNow - launchedAt < TimeSpan.FromSeconds(6);
        if (!exitedEarly)
        {
            Log(portableRoot, "browser closed normally");
            return;
        }
        Log(portableRoot, "browser process exited early - assuming a hand-off");

        DateTime appearBy = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < appearBy && !BrowserWindowOpen())
        {
            Thread.Sleep(500);
        }
        Log(portableRoot, "hand-off: window open = " + BrowserWindowOpen());

        DateTime deadline = DateTime.UtcNow.AddHours(6);
        while (DateTime.UtcNow < deadline && BrowserWindowOpen())
        {
            Thread.Sleep(1000);
        }
        Log(portableRoot, "hand-off: no browser window left");
    }

    private static bool BrowserWindowOpen()
    {
        Process[] processes = null;
        try
        {
            processes = Process.GetProcessesByName("msedge");
            foreach (Process process in processes)
            {
                try
                {
                    if (!process.HasExited && process.MainWindowHandle != IntPtr.Zero)
                    {
                        return true;
                    }
                }
                catch
                {
                    // Process vanished between enumeration and inspection.
                }
            }
        }
        catch
        {
            // Fall through to "no window".
        }
        finally
        {
            if (processes != null)
            {
                foreach (Process process in processes)
                {
                    try { process.Dispose(); } catch { }
                }
            }
        }
        return false;
    }

    private static void Fail(string portableRoot, string message)
    {
        Log(portableRoot, "fail: " + message);
        MessageBox.Show(message, "弈鉴", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    // Small startup log so a failed launch can be diagnosed from disk.
    private static void ResetLog(string portableRoot)
    {
        try
        {
            Directory.CreateDirectory(portableRoot);
            string path = Path.Combine(portableRoot, "launcher.log");
            if (File.Exists(path) && new FileInfo(path).Length > 64 * 1024)
            {
                File.Delete(path);
            }
            File.AppendAllText(
                path,
                "==== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ===="
                    + Environment.NewLine
            );
        }
        catch
        {
            // Logging is best effort only.
        }
    }

    private static void Log(string portableRoot, string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(portableRoot, "launcher.log"),
                DateTime.Now.ToString("HH:mm:ss") + "  " + message + Environment.NewLine
            );
        }
        catch
        {
            // Logging is best effort only.
        }
    }

    private static string FindEdge()
    {
        string[] candidates =
        {
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Microsoft",
                "Edge",
                "Application",
                "msedge.exe"
            ),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Microsoft",
                "Edge",
                "Application",
                "msedge.exe"
            )
        };

        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }
        return null;
    }

    private static void WriteResource(string appRoot, string resourceName, string fileName)
    {
        string target = Path.Combine(appRoot, fileName);
        Assembly assembly = Assembly.GetExecutingAssembly();

        // A previous window may still hold the file open; retry briefly rather
        // than failing the whole launch.
        for (int attempt = 0; attempt < 6; attempt += 1)
        {
            try
            {
                using (Stream input = assembly.GetManifestResourceStream(resourceName))
                {
                    if (input == null)
                    {
                        throw new InvalidOperationException("缺少应用资源：" + resourceName);
                    }
                    using (FileStream output = new FileStream(
                        target,
                        FileMode.Create,
                        FileAccess.Write,
                        FileShare.Read
                    ))
                    {
                        input.CopyTo(output);
                    }
                }
                return;
            }
            catch (IOException)
            {
                if (attempt == 5)
                {
                    throw;
                }
                Thread.Sleep(200);
            }
            catch (UnauthorizedAccessException)
            {
                if (attempt == 5)
                {
                    throw;
                }
                Thread.Sleep(200);
            }
        }
    }
}
