using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class Launcher
{
    private static volatile bool keepServing = true;

    [STAThread]
    private static void Main()
    {
        try
        {
            // Preference order: next to the exe (portable), then the per-user
            // LocalAppData folder. A read-only or protected install directory
            // (Program Files, a locked USB stick, some antivirus sandboxes) made
            // the very first launch fail here, so we fall back before writing.
            string portableRoot = ResolvePortableRoot();
            string appRoot = Path.Combine(portableRoot, "app");
            string profileRoot = Path.Combine(portableRoot, "edge-profile");

            ResetLog(portableRoot);
            Log(portableRoot, "launch: " + AppDomain.CurrentDomain.BaseDirectory);
            Log(portableRoot, "data root: " + portableRoot);

            Directory.CreateDirectory(appRoot);
            Directory.CreateDirectory(profileRoot);
            WriteResource(appRoot, "YiJian.index.html", "index.html");
            WriteResource(appRoot, "YiJian.styles.css", "styles.css");
            WriteResource(appRoot, "YiJian.ai-data.js", "ai-data.js");
            WriteResource(appRoot, "YiJian.app.js", "app.js");
            WriteResource(appRoot, "YiJian.net.js", "net.js");
            WriteResource(appRoot, "YiJian.ai-worker-bootstrap.js", "ai-worker-bootstrap.js");
            WriteResource(appRoot, "YiJian.xiangqi-kai.woff2", "xiangqi-kai.woff2");
            Log(portableRoot, "resources written to " + appRoot);

            // A plain loopback socket server. HttpListener/HTTP.sys needs a URL
            // reservation and can stall on a machine that has never registered
            // one - which is exactly the "first launch cannot connect" case.
            TcpListener server = new TcpListener(IPAddress.Loopback, 0);
            server.Start();
            int port = ((IPEndPoint)server.LocalEndpoint).Port;
            string url = string.Format("http://127.0.0.1:{0}/index.html?desktop=1", port);
            Log(portableRoot, "server: listening on 127.0.0.1:" + port);

            // LAN discovery + signalling ride on UDP; the page reaches them
            // through the /lan/* endpoints on the server above.
            StartLanService(portableRoot);

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

            Browser browser = FindBrowser();
            if (browser != null)
            {
                Log(
                    portableRoot,
                    "browser: " + browser.Name + " at " + browser.Path
                );
                Process browserProcess = LaunchBrowser(browser, url, profileRoot, appRoot);
                Log(
                    portableRoot,
                    "browser started: pid "
                        + (browserProcess == null ? "null" : browserProcess.Id.ToString())
                );
                WaitForBrowser(browserProcess, browser.ProcessName, portableRoot);
            }
            else
            {
                // No Chromium engine we recognise. Hand the URL to whatever the
                // user has set as the system default browser so the app still
                // opens in a normal tab.
                Log(portableRoot, "browser: none detected, trying system default");
                Process defaultProcess = OpenWithSystemDefault(url);
                if (defaultProcess == null)
                {
                    Diagnose(portableRoot, url);
                    keepServing = false;
                    StopLanService();
                    try { server.Stop(); } catch { }
                    return;
                }
                WaitForBrowser(defaultProcess, ProcessNameOf(defaultProcess), portableRoot);
            }

            keepServing = false;
            StopLanService();
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
                HttpRequest request = ReadRequest(stream);
                if (request == null)
                {
                    return;
                }

                // The multiplayer page reaches the LAN service over the same
                // origin, so these endpoints need no CORS handling.
                if (request.Path.StartsWith("/lan/", StringComparison.Ordinal))
                {
                    HandleLan(request, stream);
                    return;
                }

                string path = request.Path;
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

    private sealed class HttpRequest
    {
        public string Method = "GET";
        public string Path = "/";
        public string Query = string.Empty;
        public Dictionary<string, string> Headers =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public byte[] Body = new byte[0];
    }

    // Minimal HTTP/1.1 request reader: request line, headers and an optional
    // Content-Length body. That is everything the /lan/* endpoints need.
    private static HttpRequest ReadRequest(NetworkStream stream)
    {
        List<byte> buffer = new List<byte>(1024);
        byte[] single = new byte[1];
        while (buffer.Count < 65536)
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

        string head = Encoding.UTF8.GetString(buffer.ToArray());
        HttpRequest request = new HttpRequest();
        string[] lines = head.Split(new string[] { "\r\n" }, StringSplitOptions.None);
        string[] requestLine = lines[0].Split(' ');
        if (requestLine.Length >= 1 && requestLine[0].Length > 0)
        {
            request.Method = requestLine[0].ToUpperInvariant();
        }
        string target = requestLine.Length >= 2 ? requestLine[1] : "/";
        int query = target.IndexOf('?');
        if (query >= 0)
        {
            request.Path = target.Substring(0, query);
            request.Query = target.Substring(query + 1);
        }
        else
        {
            request.Path = target;
        }

        for (int index = 1; index < lines.Length; index += 1)
        {
            int colon = lines[index].IndexOf(':');
            if (colon <= 0)
            {
                continue;
            }
            request.Headers[lines[index].Substring(0, colon).Trim()] =
                lines[index].Substring(colon + 1).Trim();
        }

        int length = 0;
        string contentLength;
        if (request.Headers.TryGetValue("Content-Length", out contentLength))
        {
            int.TryParse(contentLength, out length);
        }
        if (length > 0 && length <= 1024 * 1024)
        {
            byte[] body = new byte[length];
            int got = 0;
            while (got < length)
            {
                int read = stream.Read(body, got, length - got);
                if (read <= 0)
                {
                    break;
                }
                got += read;
            }
            request.Body = body;
        }
        return request;
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

    private static void WaitForBrowser(
        Process browserProcess,
        string processName,
        string portableRoot
    )
    {
        DateTime launchedAt = DateTime.UtcNow;
        if (browserProcess != null)
        {
            browserProcess.WaitForExit();
        }

        // The launched process may only be a hand-off stub (typical on a fresh
        // profile, and whenever the browser is already running). Keep the server
        // alive while a real browser window is still up.
        bool exitedEarly = browserProcess == null
            || DateTime.UtcNow - launchedAt < TimeSpan.FromSeconds(6);
        if (!exitedEarly)
        {
            Log(portableRoot, "browser closed normally");
            return;
        }
        Log(portableRoot, "browser process exited early - assuming a hand-off");

        DateTime appearBy = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < appearBy && !BrowserWindowOpen(processName))
        {
            Thread.Sleep(500);
        }
        Log(portableRoot, "hand-off: window open = " + BrowserWindowOpen(processName));

        DateTime deadline = DateTime.UtcNow.AddHours(6);
        while (DateTime.UtcNow < deadline && BrowserWindowOpen(processName))
        {
            Thread.Sleep(1000);
        }
        Log(portableRoot, "hand-off: no browser window left");
    }

    // Only the engine we actually launched is considered. Watching every known
    // browser would let the user's unrelated Chrome window keep this process
    // (and its little web server) alive forever.
    private static bool BrowserWindowOpen(string processName)
    {
        if (string.IsNullOrEmpty(processName))
        {
            return false;
        }

        Process[] processes = null;
        try
        {
            processes = Process.GetProcessesByName(processName);
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
            // Treat an enumeration failure as "no window".
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

    // ------------------------------------------------------------- LAN service
    //
    // Minecraft-style LAN play without any game server: the launcher announces
    // the room over UDP broadcast and ferries opaque signalling blobs between
    // peers. It never looks inside a blob - WebRTC and the game protocol live
    // entirely in the page (net.js / app.js).

    private const int LanPort = 45455;
    private const string LanAnnouncePrefix = "YJA\t";
    private const string LanBlobPrefix = "YJS\t";
    private static readonly TimeSpan LanRoomTtl = TimeSpan.FromSeconds(6);

    private sealed class LanRoom
    {
        public string Id;
        public string Name;
        public string Ip;
        public int Port;
        public DateTime SeenAt;
    }

    private sealed class LanBlob
    {
        public string Ip;
        public int Port;
        public string Json;
    }

    private static readonly object lanLock = new object();
    private static readonly Dictionary<string, LanRoom> lanRooms =
        new Dictionary<string, LanRoom>(StringComparer.Ordinal);
    private static readonly List<LanBlob> lanBlobs = new List<LanBlob>();
    private static volatile UdpClient lanSocket;
    private static volatile string lanAnnounceId;
    private static volatile string lanAnnounceName = string.Empty;

    private static void StartLanService(string portableRoot)
    {
        try
        {
            UdpClient socket = new UdpClient();
            socket.ExclusiveAddressUse = false;
            socket.Client.SetSocketOption(
                SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true
            );
            socket.Client.Bind(new IPEndPoint(IPAddress.Any, LanPort));
            socket.EnableBroadcast = true;
            lanSocket = socket;

            Thread receiver = new Thread(LanReceiveLoop);
            receiver.IsBackground = true;
            receiver.Start();

            Thread announcer = new Thread(LanAnnounceLoop);
            announcer.IsBackground = true;
            announcer.Start();

            Log(portableRoot, "lan: listening on udp " + LanPort);
        }
        catch (Exception error)
        {
            lanSocket = null;
            Log(portableRoot, "lan: unavailable - " + error.Message);
        }
    }

    private static void StopLanService()
    {
        UdpClient socket = lanSocket;
        lanSocket = null;
        if (socket != null)
        {
            try { socket.Close(); } catch { }
        }
    }

    private static void LanReceiveLoop()
    {
        while (keepServing)
        {
            UdpClient socket = lanSocket;
            if (socket == null)
            {
                return;
            }
            IPEndPoint remote = new IPEndPoint(IPAddress.Any, 0);
            byte[] payload;
            try
            {
                payload = socket.Receive(ref remote);
            }
            catch
            {
                // Socket closed on shutdown, or a malformed datagram.
                if (!keepServing || lanSocket == null)
                {
                    return;
                }
                continue;
            }

            string text;
            try { text = Encoding.UTF8.GetString(payload); }
            catch { continue; }

            if (text.StartsWith(LanAnnouncePrefix, StringComparison.Ordinal))
            {
                string[] parts = text.Split('\t');
                if (parts.Length >= 3)
                {
                    // Ignore the echo of our own broadcast.
                    if (parts[1] == lanAnnounceId)
                    {
                        continue;
                    }
                    LanRememberRoom(parts[1], parts[2], remote.Address.ToString(), LanPort);
                    // Answer straight back over unicast as well. Some access
                    // points deliver broadcast in only one direction, and this
                    // makes sure the other side learns about us regardless.
                    LanReplyAnnounce(remote);
                }
                continue;
            }

            if (text.StartsWith(LanBlobPrefix, StringComparison.Ordinal))
            {
                LanRememberBlob(
                    remote.Address.ToString(),
                    remote.Port,
                    text.Substring(LanBlobPrefix.Length)
                );
            }
        }
    }

    private static void LanRememberRoom(string id, string name, string ip, int port)
    {
        if (string.IsNullOrEmpty(id))
        {
            return;
        }
        lock (lanLock)
        {
            LanRoom room;
            if (!lanRooms.TryGetValue(id, out room))
            {
                room = new LanRoom { Id = id };
                lanRooms[id] = room;
            }
            room.Name = name;
            room.Ip = ip;
            room.Port = port;
            room.SeenAt = DateTime.UtcNow;
        }
    }

    private static void LanRememberBlob(string ip, int port, string json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return;
        }
        lock (lanLock)
        {
            // A session produces a handful of blobs; the cap only guards
            // against a runaway sender.
            if (lanBlobs.Count >= 2000)
            {
                lanBlobs.RemoveRange(0, 1000);
            }
            lanBlobs.Add(new LanBlob { Ip = ip, Port = port, Json = json });
        }
    }

    // Unicast version of our own announcement, sent straight back to whoever
    // just announced. Broadcast sometimes only travels one way on a given
    // access point, and this makes discovery work either way.
    private static void LanReplyAnnounce(IPEndPoint remote)
    {
        UdpClient socket = lanSocket;
        string id = lanAnnounceId;
        if (socket == null || string.IsNullOrEmpty(id))
        {
            return;
        }
        byte[] payload = Encoding.UTF8.GetBytes(
            LanAnnouncePrefix + id + "\t" + (lanAnnounceName ?? string.Empty)
        );
        try
        {
            socket.Send(payload, payload.Length, new IPEndPoint(remote.Address, LanPort));
        }
        catch
        {
            // Peer vanished or the interface refused the unicast.
        }
    }

    // Every non-loopback IPv4 address, so the page can show the user which
    // network it is actually on.
    private static string LanLocalAddressesJson()
    {
        StringBuilder builder = new StringBuilder("[");
        bool first = true;
        try
        {
            foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (adapter.OperationalStatus != OperationalStatus.Up)
                {
                    continue;
                }
                if (adapter.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                {
                    continue;
                }
                foreach (UnicastIPAddressInformation info in adapter.GetIPProperties().UnicastAddresses)
                {
                    if (info.Address.AddressFamily != AddressFamily.InterNetwork)
                    {
                        continue;
                    }
                    if (IPAddress.IsLoopback(info.Address))
                    {
                        continue;
                    }
                    if (!first)
                    {
                        builder.Append(',');
                    }
                    first = false;
                    builder.Append('"').Append(JsonEscape(info.Address.ToString())).Append('"');
                }
            }
        }
        catch
        {
            // Report whatever was collected so far.
        }
        builder.Append(']');
        return builder.ToString();
    }

    private static void LanAnnounceLoop()
    {
        while (keepServing)
        {
            UdpClient socket = lanSocket;
            string id = lanAnnounceId;
            if (socket != null && !string.IsNullOrEmpty(id))
            {
                byte[] payload = Encoding.UTF8.GetBytes(
                    LanAnnouncePrefix + id + "\t" + (lanAnnounceName ?? string.Empty)
                );
                foreach (IPAddress target in LanBroadcastAddresses())
                {
                    try
                    {
                        socket.Send(payload, payload.Length, new IPEndPoint(target, LanPort));
                    }
                    catch
                    {
                        // Some adapters reject broadcast; the others still carry it.
                    }
                }
            }
            Thread.Sleep(1500);
        }
    }

    private static List<IPAddress> LanBroadcastAddresses()
    {
        List<IPAddress> targets = new List<IPAddress>();
        try
        {
            foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (adapter.OperationalStatus != OperationalStatus.Up)
                {
                    continue;
                }
                if (adapter.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                {
                    continue;
                }
                foreach (UnicastIPAddressInformation info in adapter.GetIPProperties().UnicastAddresses)
                {
                    if (info.Address.AddressFamily != AddressFamily.InterNetwork)
                    {
                        continue;
                    }
                    IPAddress mask = info.IPv4Mask;
                    if (mask == null)
                    {
                        continue;
                    }
                    byte[] address = info.Address.GetAddressBytes();
                    byte[] maskBytes = mask.GetAddressBytes();
                    if (address.Length != 4 || maskBytes.Length != 4)
                    {
                        continue;
                    }
                    byte[] broadcast = new byte[4];
                    for (int index = 0; index < 4; index += 1)
                    {
                        broadcast[index] = (byte)(address[index] | (maskBytes[index] ^ 255));
                    }
                    targets.Add(new IPAddress(broadcast));
                }
            }
        }
        catch
        {
            // Fall through to the limited broadcast address.
        }
        if (targets.Count == 0)
        {
            targets.Add(IPAddress.Broadcast);
        }
        return targets;
    }

    private static void LanSend(string ip, int port, string json)
    {
        UdpClient socket = lanSocket;
        IPAddress address;
        if (socket == null || string.IsNullOrEmpty(json))
        {
            return;
        }
        if (!IPAddress.TryParse(ip, out address))
        {
            return;
        }
        byte[] payload = Encoding.UTF8.GetBytes(LanBlobPrefix + json);
        try
        {
            socket.Send(payload, payload.Length, new IPEndPoint(address, port > 0 ? port : LanPort));
        }
        catch
        {
            // Peer went away between discovery and send.
        }
    }

    private static string LanRoomsJson()
    {
        StringBuilder builder = new StringBuilder();
        builder.Append("{\"rooms\":[");
        DateTime now = DateTime.UtcNow;
        lock (lanLock)
        {
            List<string> stale = new List<string>();
            bool first = true;
            foreach (KeyValuePair<string, LanRoom> entry in lanRooms)
            {
                LanRoom room = entry.Value;
                if (now - room.SeenAt > LanRoomTtl)
                {
                    stale.Add(entry.Key);
                    continue;
                }
                if (!first)
                {
                    builder.Append(',');
                }
                first = false;
                builder.Append("{\"id\":\"").Append(JsonEscape(room.Id))
                    .Append("\",\"name\":\"").Append(JsonEscape(room.Name))
                    .Append("\",\"ip\":\"").Append(JsonEscape(room.Ip))
                    .Append("\",\"port\":").Append(room.Port)
                    .Append(",\"lastSeen\":")
                    .Append((long)(now - room.SeenAt).TotalMilliseconds)
                    .Append('}');
            }
            foreach (string key in stale)
            {
                lanRooms.Remove(key);
            }
        }
        builder.Append("]}");
        return builder.ToString();
    }

    private static string LanInboxJson(int since, int waitMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
        while (true)
        {
            lock (lanLock)
            {
                int count = lanBlobs.Count;
                if (count > since || waitMs <= 0 || DateTime.UtcNow >= deadline)
                {
                    int from = Math.Max(0, Math.Min(since, count));
                    StringBuilder builder = new StringBuilder();
                    builder.Append("{\"cursor\":").Append(count).Append(",\"blobs\":[");
                    for (int index = from; index < count; index += 1)
                    {
                        if (index > from)
                        {
                            builder.Append(',');
                        }
                        LanBlob blob = lanBlobs[index];
                        builder.Append("{\"ip\":\"").Append(JsonEscape(blob.Ip))
                            .Append("\",\"port\":").Append(blob.Port)
                            .Append(",\"data\":").Append(blob.Json)
                            .Append('}');
                    }
                    builder.Append("]}");
                    return builder.ToString();
                }
            }
            Thread.Sleep(40);
        }
    }

    private static void HandleLan(HttpRequest request, NetworkStream stream)
    {
        string path = request.Path;
        if (path == "/lan/hello")
        {
            WriteJson(
                stream,
                "{\"ok\":true,\"proto\":1,\"name\":\"YiJian\",\"platform\":\"windows\""
                    + ",\"udp\":" + LanPort + ",\"active\":" + (lanSocket != null ? "true" : "false")
                    + ",\"ips\":" + LanLocalAddressesJson()
                    + "}"
            );
            return;
        }
        if (path == "/lan/rooms")
        {
            WriteJson(stream, LanRoomsJson());
            return;
        }
        if (path == "/lan/announce" && request.Method == "POST")
        {
            Dictionary<string, object> body = ParseJson(request.Body);
            bool stop = body != null && body.ContainsKey("stop")
                && Convert.ToBoolean(body["stop"]);
            if (stop)
            {
                lanAnnounceId = null;
            }
            else
            {
                Dictionary<string, object> room = body != null && body.ContainsKey("room")
                    ? body["room"] as Dictionary<string, object>
                    : null;
                if (room != null)
                {
                    lanAnnounceName = Str(room, "name");
                    lanAnnounceId = Str(room, "id");
                }
            }
            WriteJson(stream, "{\"ok\":true}");
            return;
        }
        if (path == "/lan/send" && request.Method == "POST")
        {
            Dictionary<string, object> body = ParseJson(request.Body);
            if (body != null)
            {
                object data = body.ContainsKey("data") ? body["data"] : null;
                string json = data as string;
                if (json == null && data != null)
                {
                    json = new JavaScriptSerializer().Serialize(data);
                }
                LanSend(Str(body, "ip"), ToInt(body, "port"), json);
            }
            WriteJson(stream, "{\"ok\":true}");
            return;
        }
        if (path == "/lan/inbox")
        {
            int since = QueryInt(request.Query, "since", 0);
            int wait = QueryInt(request.Query, "wait", 0);
            if (wait < 0) wait = 0;
            if (wait > 30000) wait = 30000;
            WriteJson(stream, LanInboxJson(since, wait));
            return;
        }
        WriteResponse(
            stream,
            404,
            "text/plain; charset=utf-8",
            Encoding.UTF8.GetBytes("Not found")
        );
    }

    private static void WriteJson(NetworkStream stream, string json)
    {
        WriteResponse(
            stream,
            200,
            "application/json; charset=utf-8",
            Encoding.UTF8.GetBytes(json)
        );
    }

    private static Dictionary<string, object> ParseJson(byte[] body)
    {
        if (body == null || body.Length == 0)
        {
            return null;
        }
        try
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 8 * 1024 * 1024;
            return serializer.Deserialize<Dictionary<string, object>>(
                Encoding.UTF8.GetString(body)
            );
        }
        catch
        {
            return null;
        }
    }

    private static string Str(Dictionary<string, object> dict, string key)
    {
        if (dict == null || !dict.ContainsKey(key))
        {
            return string.Empty;
        }
        object value = dict[key];
        return value == null ? string.Empty : Convert.ToString(value);
    }

    private static int ToInt(Dictionary<string, object> dict, string key)
    {
        if (dict == null || !dict.ContainsKey(key))
        {
            return 0;
        }
        try
        {
            return Convert.ToInt32(dict[key]);
        }
        catch
        {
            return 0;
        }
    }

    private static int QueryInt(string query, string key, int fallback)
    {
        if (string.IsNullOrEmpty(query))
        {
            return fallback;
        }
        string[] pairs = query.Split('&');
        foreach (string pair in pairs)
        {
            int equals = pair.IndexOf('=');
            string name = equals >= 0 ? pair.Substring(0, equals) : pair;
            if (!string.Equals(name, key, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            int value;
            if (equals >= 0 && int.TryParse(pair.Substring(equals + 1), out value))
            {
                return value;
            }
        }
        return fallback;
    }

    private static string JsonEscape(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }
        StringBuilder builder = new StringBuilder(text.Length + 8);
        foreach (char letter in text)
        {
            switch (letter)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (letter < ' ')
                    {
                        builder.Append("\\u").Append(((int)letter).ToString("x4"));
                    }
                    else
                    {
                        builder.Append(letter);
                    }
                    break;
            }
        }
        return builder.ToString();
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

    // A Chromium engine we can drive in app mode. Every engine below accepts
    // the same --app / --user-data-dir command line.
    private sealed class Browser
    {
        public string Name;
        public string Path;
        public string ProcessName;
    }

    private static Browser Known(string name, string path)
    {
        string processName = Path.GetFileNameWithoutExtension(path);
        return new Browser { Name = name, Path = path, ProcessName = processName };
    }

    private static Browser FindBrowser()
    {
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        // Microsoft Edge first - but "精简版" Windows images ship without it,
        // which is exactly the machine that used to fail to launch.
        string edge = FirstExisting(
            ReadAppPath("msedge.exe"),
            Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
        );
        if (edge != null)
        {
            return Known("Microsoft Edge", edge);
        }

        string chrome = FirstExisting(
            ReadAppPath("chrome.exe"),
            Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe")
        );
        if (chrome != null)
        {
            return Known("Google Chrome", chrome);
        }

        string brave = FirstExisting(
            ReadAppPath("brave.exe"),
            Path.Combine(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            Path.Combine(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            Path.Combine(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
        );
        if (brave != null)
        {
            return Known("Brave", brave);
        }

        string vivaldi = FirstExisting(
            ReadAppPath("vivaldi.exe"),
            Path.Combine(localAppData, "Vivaldi", "Application", "vivaldi.exe"),
            Path.Combine(programFiles, "Vivaldi", "Application", "vivaldi.exe"),
            Path.Combine(programFilesX86, "Vivaldi", "Application", "vivaldi.exe")
        );
        if (vivaldi != null)
        {
            return Known("Vivaldi", vivaldi);
        }

        string opera = FirstExisting(
            ReadAppPath("opera.exe"),
            Path.Combine(localAppData, "Programs", "Opera", "opera.exe"),
            Path.Combine(programFiles, "Opera", "opera.exe"),
            Path.Combine(programFilesX86, "Opera", "opera.exe")
        );
        if (opera != null)
        {
            return Known("Opera", opera);
        }

        // 360 / QQ browsers are the common Chromium shells on consumer PCs here.
        string qihoo = FirstExisting(
            ReadAppPath("360se.exe"),
            ReadAppPath("360chrome.exe"),
            Path.Combine(programFilesX86, "360", "360se6", "Application", "360se.exe"),
            Path.Combine(programFiles, "360", "360se6", "Application", "360se.exe"),
            Path.Combine(localAppData, "360Chrome", "Chrome", "Application", "360chrome.exe")
        );
        if (qihoo != null)
        {
            return Known("360 浏览器", qihoo);
        }

        string qq = FirstExisting(
            ReadAppPath("QQBrowser.exe"),
            Path.Combine(programFiles, "Tencent", "QQBrowser", "QQBrowser.exe"),
            Path.Combine(programFilesX86, "Tencent", "QQBrowser", "QQBrowser.exe")
        );
        if (qq != null)
        {
            return Known("QQ 浏览器", qq);
        }

        return null;
    }

    private static Process LaunchBrowser(
        Browser browser,
        string url,
        string profileRoot,
        string appRoot
    )
    {
        string arguments = string.Format(
            "--app=\"{0}\" --user-data-dir=\"{1}\" --start-maximized "
                + "--no-first-run --no-default-browser-check --disable-sync",
            url,
            profileRoot
        );

        return Process.Start(new ProcessStartInfo
        {
            FileName = browser.Path,
            Arguments = arguments,
            UseShellExecute = false,
            WorkingDirectory = appRoot
        });
    }

    // Hand the URL to whichever browser the user set as default. This covers
    // engines we do not know by name (Firefox, a portable build, ...).
    private static Process OpenWithSystemDefault(string url)
    {
        try
        {
            return Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch
        {
            return null;
        }
    }

    private static string ProcessNameOf(Process process)
    {
        try
        {
            return process.ProcessName;
        }
        catch
        {
            return null;
        }
    }

    private static string FirstExisting(params string[] candidates)
    {
        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate))
            {
                return candidate;
            }
        }
        return null;
    }

    // Most Chromium installs register under App Paths, which catches per-user
    // installs and non-standard folders the hard-coded list would miss.
    private static string ReadAppPath(string exeName)
    {
        string[] subKeys =
        {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exeName,
            @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\" + exeName
        };
        RegistryKey[] roots = { Registry.CurrentUser, Registry.LocalMachine };

        foreach (RegistryKey root in roots)
        {
            foreach (string subKey in subKeys)
            {
                try
                {
                    using (RegistryKey key = root.OpenSubKey(subKey))
                    {
                        if (key == null)
                        {
                            continue;
                        }
                        string value = key.GetValue(null) as string;
                        if (!string.IsNullOrEmpty(value) && File.Exists(value))
                        {
                            return value;
                        }
                    }
                }
                catch
                {
                    // Missing or unreadable keys are expected; keep looking.
                }
            }
        }
        return null;
    }

    // The exe folder first (portable), then a per-user folder that is always
    // writable. Program Files, roamed shares and sandboxed download folders
    // used to abort the very first launch because the log write failed.
    private static string ResolvePortableRoot()
    {
        string primary = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "YiJian-data");
        if (IsWritable(primary))
        {
            return primary;
        }

        string fallback = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "YiJian"
        );
        if (IsWritable(fallback))
        {
            return fallback;
        }
        return primary;
    }

    private static bool IsWritable(string directory)
    {
        try
        {
            Directory.CreateDirectory(directory);
            string probe = Path.Combine(directory, ".write-probe");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch
        {
            return false;
        }
    }

    // Last resort: no browser we could launch. Keep the URL copyable and put it
    // on the clipboard so it can be pasted into any browser by hand.
    private static void Diagnose(string portableRoot, string url)
    {
        Log(portableRoot, "diagnose: no browser, url " + url);
        try { Clipboard.SetText(url); } catch { }

        string message =
            "未能自动打开浏览器，但本地服务已经启动。" + Environment.NewLine
            + Environment.NewLine
            + "请在任意浏览器中打开下面的地址：" + Environment.NewLine
            + url + Environment.NewLine
            + Environment.NewLine
            + "该地址已复制到剪贴板。";
        MessageBox.Show(message, "弈鉴", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
