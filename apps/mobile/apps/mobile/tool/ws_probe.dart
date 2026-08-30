import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

Future<void> main() async {
  final ws = WebSocketChannel.connect(Uri.parse('ws://127.0.0.1:19532/ws'));
  await ws.ready;
  print('connected');
  ws.stream.listen((raw) {
    print('recv: $raw');
  });
  ws.sink.add(jsonEncode({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
    'protocolVersion': '1.0',
    'capabilities': {'platform': 'mobile', 'features': [], 'excludes': ['subprocess']}
  }}));
  await Future<void>.delayed(const Duration(seconds: 2));
  await ws.sink.close();
}
