package com.yijian.xiangqi;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * LAN discovery and signalling for the Android build.
 *
 * It does exactly what the Windows launcher does: broadcast a room over UDP and
 * ferry opaque signalling blobs between peers. The contents of a blob are never
 * inspected here - WebRTC and the game protocol live in the page (net.js /
 * app.js). The four actions mirror the desktop /lan/* endpoints so the web
 * layer can use either shell through the same interface.
 */
@CapacitorPlugin(name = "YiJianLan")
public class YiJianLanPlugin extends Plugin {

    private static final String TAG = "YiJianLan";
    private static final int LAN_PORT = 45455;
    private static final String ANNOUNCE_PREFIX = "YJA\t";
    private static final String BLOB_PREFIX = "YJS\t";
    private static final long ROOM_TTL_MS = 6000L;
    private static final long ANNOUNCE_INTERVAL_MS = 1500L;
    private static final int MAX_BLOBS = 2000;

    private static final Object LOCK = new Object();
    private static final Map<String, Room> ROOMS = new LinkedHashMap<>();
    private static final List<Blob> BLOBS = new ArrayList<>();

    private static DatagramSocket socket;
    private static Thread receiver;
    private static Thread announcer;
    private static volatile boolean running;
    private static volatile String announceId;
    private static volatile String announceName = "";
    private static WifiManager.MulticastLock multicastLock;

    private static final class Room {
        String id;
        String name;
        String ip;
        int port;
        long seenAt;
    }

    private static final class Blob {
        String ip;
        int port;
        JSObject data;
    }

    @Override
    public void load() {
        startService(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        stopService();
    }

    // ------------------------------------------------------------ plugin methods

    @PluginMethod
    public void announce(PluginCall call) {
        Boolean stop = call.getBoolean("stop");
        if (stop != null && stop) {
            announceId = null;
        } else {
            JSObject room = call.getObject("room");
            if (room == null) {
                call.reject("room is required");
                return;
            }
            announceName = room.optString("name", "");
            announceId = room.optString("id", "");
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void rooms(PluginCall call) {
        JSArray list = new JSArray();
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            Iterator<Map.Entry<String, Room>> iterator = ROOMS.entrySet().iterator();
            while (iterator.hasNext()) {
                Room room = iterator.next().getValue();
                if (now - room.seenAt > ROOM_TTL_MS) {
                    iterator.remove();
                    continue;
                }
                JSObject item = new JSObject();
                item.put("id", room.id);
                item.put("name", room.name);
                item.put("ip", room.ip);
                item.put("port", room.port);
                item.put("lastSeen", now - room.seenAt);
                list.put(item);
            }
        }
        JSObject result = new JSObject();
        result.put("rooms", list);
        call.resolve(result);
    }

    @PluginMethod
    public void send(PluginCall call) {
        String ip = call.getString("ip");
        Integer port = call.getInt("port");
        JSObject data = call.getObject("data");
        DatagramSocket current = socket;
        if (ip != null && data != null && current != null) {
            byte[] payload = (BLOB_PREFIX + data.toString()).getBytes(StandardCharsets.UTF_8);
            try {
                current.send(new DatagramPacket(
                        payload,
                        payload.length,
                        InetAddress.getByName(ip),
                        port != null && port > 0 ? port : LAN_PORT
                ));
            } catch (Exception error) {
                Log.w(TAG, "send failed: " + error.getMessage());
            }
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void inbox(PluginCall call) {
        Integer since = call.getInt("since");
        int from = since == null ? 0 : Math.max(0, since);
        JSArray list = new JSArray();
        int cursor;
        synchronized (LOCK) {
            cursor = BLOBS.size();
            if (from > cursor) {
                from = cursor;
            }
            for (int index = from; index < cursor; index += 1) {
                Blob blob = BLOBS.get(index);
                JSObject item = new JSObject();
                item.put("ip", blob.ip);
                item.put("port", blob.port);
                item.put("data", blob.data);
                list.put(item);
            }
        }
        JSObject result = new JSObject();
        result.put("cursor", cursor);
        result.put("blobs", list);
        call.resolve(result);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("proto", 1);
        result.put("name", "YiJian");
        result.put("platform", "android");
        result.put("udp", LAN_PORT);
        result.put("active", running);
        call.resolve(result);
    }

    // --------------------------------------------------------------- service side

    private static synchronized void startService(Context context) {
        if (running) {
            return;
        }
        try {
            DatagramSocket created = new DatagramSocket(null);
            created.setReuseAddress(true);
            created.setBroadcast(true);
            created.bind(new InetSocketAddress("0.0.0.0", LAN_PORT));
            socket = created;
            running = true;
            acquireMulticastLock(context);

            receiver = new Thread(YiJianLanPlugin::receiveLoop, "yijian-lan-rx");
            receiver.setDaemon(true);
            receiver.start();

            announcer = new Thread(YiJianLanPlugin::announceLoop, "yijian-lan-tx");
            announcer.setDaemon(true);
            announcer.start();

            Log.i(TAG, "listening on udp " + LAN_PORT);
        } catch (Exception error) {
            Log.w(TAG, "lan unavailable: " + error.getMessage());
            DatagramSocket failed = socket;
            socket = null;
            running = false;
            if (failed != null) {
                failed.close();
            }
        }
    }

    private static synchronized void stopService() {
        running = false;
        announceId = null;
        DatagramSocket current = socket;
        socket = null;
        if (current != null) {
            current.close();
        }
        if (multicastLock != null) {
            try {
                if (multicastLock.isHeld()) {
                    multicastLock.release();
                }
            } catch (Exception error) {
                Log.w(TAG, "multicast lock release failed: " + error.getMessage());
            }
            multicastLock = null;
        }
        synchronized (LOCK) {
            ROOMS.clear();
            BLOBS.clear();
        }
    }

    private static void acquireMulticastLock(Context context) {
        try {
            WifiManager wifi = (WifiManager) context.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) {
                return;
            }
            multicastLock = wifi.createMulticastLock("yijian-lan");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        } catch (Exception error) {
            Log.w(TAG, "multicast lock unavailable: " + error.getMessage());
        }
    }

    private static void receiveLoop() {
        byte[] buffer = new byte[8192];
        while (running) {
            DatagramSocket current = socket;
            if (current == null) {
                return;
            }
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            try {
                current.receive(packet);
            } catch (Exception error) {
                if (!running || socket == null) {
                    return;
                }
                continue;
            }

            String text = new String(
                    packet.getData(),
                    packet.getOffset(),
                    packet.getLength(),
                    StandardCharsets.UTF_8
            );
            String ip = packet.getAddress().getHostAddress();
            int port = packet.getPort();

            if (text.startsWith(ANNOUNCE_PREFIX)) {
                String[] parts = text.split("\t", -1);
                if (parts.length >= 3) {
                    // Our own broadcast loops back through the Wi-Fi stack.
                    if (parts[1].equals(announceId)) {
                        continue;
                    }
                    rememberRoom(parts[1], parts[2], ip);
                }
            } else if (text.startsWith(BLOB_PREFIX)) {
                rememberBlob(ip, port, text.substring(BLOB_PREFIX.length()));
            }
        }
    }

    private static void rememberRoom(String id, String name, String ip) {
        if (id == null || id.isEmpty()) {
            return;
        }
        synchronized (LOCK) {
            Room room = ROOMS.get(id);
            if (room == null) {
                room = new Room();
                room.id = id;
                ROOMS.put(id, room);
            }
            room.name = name;
            room.ip = ip;
            room.port = LAN_PORT;
            room.seenAt = System.currentTimeMillis();
        }
    }

    private static void rememberBlob(String ip, int port, String json) {
        if (json == null || json.isEmpty()) {
            return;
        }
        JSObject data;
        try {
            data = new JSObject(json);
        } catch (Exception error) {
            return;
        }
        synchronized (LOCK) {
            if (BLOBS.size() >= MAX_BLOBS) {
                BLOBS.subList(0, MAX_BLOBS / 2).clear();
            }
            Blob blob = new Blob();
            blob.ip = ip;
            blob.port = port;
            blob.data = data;
            BLOBS.add(blob);
        }
    }

    private static void announceLoop() {
        while (running) {
            String id = announceId;
            DatagramSocket current = socket;
            if (current != null && id != null && !id.isEmpty()) {
                byte[] payload = (ANNOUNCE_PREFIX + id + "\t" + announceName)
                        .getBytes(StandardCharsets.UTF_8);
                for (InetAddress target : broadcastAddresses()) {
                    try {
                        current.send(new DatagramPacket(payload, payload.length, target, LAN_PORT));
                    } catch (Exception error) {
                        // Some interfaces reject broadcast; the others still carry it.
                    }
                }
            }
            try {
                Thread.sleep(ANNOUNCE_INTERVAL_MS);
            } catch (InterruptedException interrupted) {
                return;
            }
        }
    }

    private static List<InetAddress> broadcastAddresses() {
        List<InetAddress> targets = new ArrayList<>();
        try {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) {
                    continue;
                }
                for (InterfaceAddress address : network.getInterfaceAddresses()) {
                    InetAddress broadcast = address.getBroadcast();
                    if (broadcast != null && broadcast.getAddress().length == 4) {
                        targets.add(broadcast);
                    }
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "broadcast scan failed: " + error.getMessage());
        }
        if (targets.isEmpty()) {
            try {
                targets.add(InetAddress.getByName("255.255.255.255"));
            } catch (Exception error) {
                Log.w(TAG, "limited broadcast unavailable: " + error.getMessage());
            }
        }
        return targets;
    }
}
