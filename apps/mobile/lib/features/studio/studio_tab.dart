import 'dart:convert';
import 'dart:async';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show Colors;
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/glass.dart';
import '../../core/harness_client.dart';
import '../../core/ios_ui.dart';
import '../common/model_picker.dart';

/// 绘图 Studio：生成 / 编辑 / 图库 / 队列四个并列功能（顶部分段切换），参数对齐桌面端。
class StudioTab extends ConsumerStatefulWidget {
  const StudioTab({super.key});

  @override
  ConsumerState<StudioTab> createState() => _StudioTabState();
}

class _StudioTabState extends ConsumerState<StudioTab> {
  final _promptCtrl = TextEditingController();
  final _negativeCtrl = TextEditingController();
  final _searchCtrl = TextEditingController();
  int _view = 0; // 0 生成 | 1 编辑 | 2 图库 | 3 队列
  String _aspect = '1:1';
  String _resolution = '1K';
  String _quality = 'auto';
  String _format = 'png';
  int _n = 1;
  ImageEntry? _editSource;
  List<ImageEntry> _gallery = [];
  String _search = '';
  String? _activeFolder;
  final List<String> _folderNames = [];
  String? _providerId; // null = 默认
  String? _model;
  String _providerName = '';
  List<StudioTask> _tasks = [];
  int _maxConcurrentTasks = 2;
  final Map<String, StreamSubscription<EventFrame>> _taskSubs = {};
  StreamSubscription<EventFrame>? _agentTaskSub;
  StreamSubscription<void>? _studioTaskChangedSub;
  Future<void> _taskSaveQueue = Future<void>.value();

  static const _aspects = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4'];
  static const _resolutions = ['1K', '2K', '4K'];
  static const _qualities = ['auto', 'low', 'medium', 'high'];
  static const _formats = ['png', 'jpeg', 'webp'];
  static const _folderPrefsKey = 'studio:imageFolders';

  bool _hasEntryParam(ImageEntry entry, String? value, List<String> allowed) =>
      value != null && allowed.contains(value);

  void _applyEntryParams(ImageEntry entry) {
    _promptCtrl.text = entry.prompt;
    _negativeCtrl.text = entry.negativePrompt;
    _aspect = _hasEntryParam(entry, entry.aspect, _aspects)
        ? entry.aspect!
        : '1:1';
    _resolution = _hasEntryParam(entry, entry.resolution, _resolutions)
        ? entry.resolution!
        : '1K';
    _quality = _hasEntryParam(entry, entry.quality, _qualities)
        ? entry.quality!
        : 'auto';
    _format = _hasEntryParam(entry, entry.format, _formats)
        ? entry.format!
        : 'png';
    _n = 1;
    _providerId = entry.providerId;
    _model = entry.model;
    _providerName = entry.providerId == null ? '' : '原图';
  }

  Future<void> _showPromptOptimizer({required bool isNegative}) async {
    final sourceCtrl = isNegative ? _negativeCtrl : _promptCtrl;
    final original = sourceCtrl.text.trim();
    if (original.isEmpty) return;
    final p = DawnPalette.of(context);
    final optimizedCtrl = TextEditingController();
    var optimizing = true;
    var started = false;
    String? error;

    Future<void> optimize(void Function(void Function()) setState) async {
      setState(() {
        optimizing = true;
        error = null;
      });
      try {
        final optimized = await HarnessClient.instance.optimizeStudioPrompt(
          prompt: original,
          isNegative: isNegative,
          providerId: _providerId,
        );
        setState(() {
          optimizedCtrl.text = optimized;
          optimizing = false;
        });
      } catch (e) {
        setState(() {
          error = '$e';
          optimizing = false;
        });
      }
    }

    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) {
          if (!started) {
            started = true;
            optimize(setModalState);
          }
          return Container(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.of(ctx).size.height * 0.82,
            ),
            decoration: BoxDecoration(
              color: p.groupedBg,
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(14),
              ),
            ),
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            isNegative ? 'AI 优化负向提示词' : 'AI 优化提示词',
                            style: const TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        CupertinoButton(
                          padding: EdgeInsets.zero,
                          minimumSize: const Size(28, 28),
                          onPressed: () => Navigator.pop(ctx),
                          child: const Icon(CupertinoIcons.xmark, size: 18),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '优化模型：${_providerName.isEmpty ? '默认' : _providerName}',
                      style: TextStyle(fontSize: 12, color: p.ink2),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      '原始提示词',
                      style: TextStyle(fontSize: 12, color: p.ink2),
                    ),
                    const SizedBox(height: 4),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: p.cardBg,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: p.separator),
                      ),
                      child: Text(
                        original,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                    const SizedBox(height: 12),
                    if (optimizing)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 20),
                        child: Center(child: CupertinoActivityIndicator()),
                      )
                    else if (error != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          '失败：$error',
                          style: const TextStyle(color: iosRed, fontSize: 13),
                        ),
                      )
                    else ...[
                      Text(
                        '优化结果（可编辑）',
                        style: TextStyle(fontSize: 12, color: p.ink2),
                      ),
                      const SizedBox(height: 4),
                      CupertinoTextField(
                        controller: optimizedCtrl,
                        maxLines: 6,
                        minLines: 4,
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: p.cardBg,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: p.separator),
                        ),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ],
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: CupertinoButton(
                            color: p.cardBg,
                            onPressed: optimizing
                                ? null
                                : () => optimize(setModalState),
                            child: const Text('重新优化'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: CupertinoButton.filled(
                            onPressed: optimizing
                                ? null
                                : () {
                                    final value = optimizedCtrl.text.trim();
                                    if (value.isNotEmpty) {
                                      sourceCtrl.text = value;
                                    }
                                    Navigator.pop(ctx);
                                  },
                            child: const Text('应用'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  @override
  void initState() {
    super.initState();
    _loadGallery();
    _loadFolders();
    _loadTasks();
    _loadConcurrency();
    _drainAgentTasks();
    _listenForAgentQueuedTasks();
    _studioTaskChangedSub = HarnessClient.instance.studioTasksChanged.listen((
      _,
    ) {
      _loadTasks(preserveRunning: true);
    });
  }

  @override
  void dispose() {
    for (final sub in _taskSubs.values) {
      sub.cancel();
    }
    _taskSubs.clear();
    _agentTaskSub?.cancel();
    _studioTaskChangedSub?.cancel();
    _promptCtrl.dispose();
    _negativeCtrl.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadGallery() async {
    try {
      final images = await HarnessClient.instance.studioList(
        search: _search.isEmpty ? null : _search,
      );
      if (mounted) setState(() => _gallery = images);
    } catch (_) {}
  }

  Future<void> _loadFolders() async {
    try {
      final remote = await HarnessClient.instance.studioListFolders();
      if (mounted) {
        setState(() {
          _folderNames
            ..clear()
            ..addAll(remote);
        });
        await _saveFolders();
        return;
      }
    } catch (_) {
      // Older hosts may not expose studio.folder; use the local mirror below.
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getStringList(_folderPrefsKey) ?? const <String>[];
      if (!mounted) return;
      setState(() {
        _folderNames
          ..clear()
          ..addAll(saved.where((name) => name.trim().isNotEmpty).toSet());
      });
    } catch (_) {}
  }

  Future<void> _saveFolders() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_folderPrefsKey, _folderNames);
    } catch (_) {}
  }

  Future<void> _loadTasks({bool preserveRunning = false}) async {
    try {
      final loaded = await HarnessClient.instance.loadStudioTasks();
      if (!mounted) return;
      setState(() {
        _tasks = loaded.reversed.map((task) {
          if (task.status != 'running' || preserveRunning) return task;
          final streamId = task.request['_streamId'] as String?;
          if (task.request['_chatControlled'] == true &&
              streamId != null &&
              HarnessClient.instance.isStudioStreamActive(streamId)) {
            return task;
          }
          return task.copyWith(status: 'queued');
        }).toList();
      });
      _runScheduler();
    } catch (_) {}
  }

  Future<void> _loadConcurrency() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final value = prefs.getInt('studio:maxConcurrentTasks') ?? 2;
      if (mounted) {
        setState(() {
          _maxConcurrentTasks = value.clamp(1, 8);
        });
        _runScheduler();
      }
    } catch (_) {}
  }

  Future<void> _setConcurrency(int next) async {
    final value = next.clamp(1, 8);
    if (value == _maxConcurrentTasks) return;
    setState(() => _maxConcurrentTasks = value);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt('studio:maxConcurrentTasks', value);
    } catch (_) {}
    _runScheduler();
  }

  Future<void> _saveTasks() async {
    final snapshot = [..._tasks];
    _taskSaveQueue = _taskSaveQueue
        .then((_) => HarnessClient.instance.saveStudioTasks(snapshot))
        .catchError((_) {});
    await _taskSaveQueue;
  }

  Future<void> _drainAgentTasks() async {
    try {
      final pending = await HarnessClient.instance.drainStudioTasks();
      for (final request in pending) {
        _enqueueTask(request, createdByAgent: true);
      }
    } catch (_) {}
  }

  void _listenForAgentQueuedTasks() {
    _agentTaskSub = HarnessClient.instance.events.listen((frame) {
      if (frame.kind != 'tool_result') return;
      final name = frame.data['name'] as String? ?? '';
      if (name != 'generate_image' && name != 'edit_image') return;
      final content = frame.data['content'] as String? ?? '';
      try {
        final result = jsonDecode(content);
        if (result is Map && ((result['queued'] as num?)?.toInt() ?? 0) > 0) {
          _drainAgentTasks();
        }
      } catch (_) {}
    });
  }

  StudioTask? _taskById(String id) {
    for (final task in _tasks) {
      if (task.id == id) return task;
    }
    return null;
  }

  void _replaceTask(StudioTask task) {
    if (!mounted) return;
    setState(() {
      _tasks = [
        for (final item in _tasks)
          if (item.id == task.id) task else item,
      ];
    });
  }

  void _enqueueTask(
    Map<String, dynamic> request, {
    bool createdByAgent = false,
  }) {
    final now = DateTime.now().microsecondsSinceEpoch;
    final task = StudioTask(
      id: 'studio-$now',
      status: 'queued',
      createdAt: now,
      request: request,
      label: request['prompt'] as String? ?? '',
      createdByAgent: createdByAgent,
    );
    setState(() => _tasks = [task, ..._tasks]);
    _saveTasks();
    _runScheduler();
  }

  void _runScheduler() {
    if (!mounted) return;
    var running = _tasks.where((task) => task.status == 'running').length;
    while (running < _maxConcurrentTasks) {
      StudioTask? next;
      for (final task in _tasks.reversed) {
        if (task.status == 'queued') {
          next = task;
          break;
        }
      }
      if (next == null) break;
      running += 1;
      _executeTask(next);
    }
  }

  Future<void> _executeTask(StudioTask queuedTask) async {
    final task = queuedTask.copyWith(status: 'running');
    _replaceTask(task);
    _saveTasks();
    final request = task.request;
    final taskId = task.id;
    try {
      final streamId = await HarnessClient.instance.studioGenerate(
        prompt: request['prompt'] as String? ?? '',
        mode: request['mode'] as String? ?? 'generate',
        negativePrompt: request['negativePrompt'] as String?,
        aspect:
            request['aspect'] as String? ?? request['aspectRatio'] as String?,
        resolution: request['resolution'] as String?,
        quality: request['quality'] as String?,
        format:
            request['format'] as String? ?? request['outputFormat'] as String?,
        size: request['size'] as String?,
        n: (request['n'] as num?)?.toInt() ?? 1,
        inputImageB64: request['inputImageB64'] as String?,
        inputImages:
            (request['inputImages'] as List?)?.whereType<String>().toList() ??
            const [],
        folder: request['folder'] as String?,
        tags:
            (request['tags'] as List?)?.whereType<String>().toList() ??
            const [],
        providerId: request['providerId'] as String?,
        model: request['model'] as String?,
      );
      final sub = HarnessClient.instance
          .subscribeStream(streamId)
          .listen(
            (frame) {
              final current = _taskById(taskId);
              if (current == null) return;
              if (frame.kind == 'image_ready') {
                final entry = ImageEntry.fromJson(
                  (frame.data['entry'] as Map).cast<String, dynamic>(),
                );
                _replaceTask(
                  current.copyWith(entries: [...current.entries, entry]),
                );
                _saveTasks();
                _loadGallery();
              } else if (frame.kind == 'done' || frame.kind == 'error') {
                final latest = _taskById(taskId);
                if (latest?.status == 'running') {
                  final terminal = frame.kind == 'error'
                      ? latest!.copyWith(
                          status: 'error',
                          error: frame.data['message'] as String? ?? '生成失败',
                        )
                      : latest!.copyWith(status: 'success');
                  _replaceTask(terminal);
                  _saveTasks();
                }
                HarnessClient.instance.markStudioStreamFinished(streamId);
                _taskSubs.remove(taskId)?.cancel();
                _runScheduler();
              }
            },
            onError: (Object error) {
              final current = _taskById(taskId);
              if (current?.status == 'running') {
                _replaceTask(
                  current!.copyWith(status: 'error', error: '$error'),
                );
                _saveTasks();
              }
              HarnessClient.instance.markStudioStreamFinished(streamId);
              _taskSubs.remove(taskId)?.cancel();
              _runScheduler();
            },
            onDone: () {
              final current = _taskById(taskId);
              if (current?.status == 'running') {
                _replaceTask(
                  current!.entries.isNotEmpty
                      ? current.copyWith(status: 'success')
                      : current.copyWith(status: 'error', error: '连接中断'),
                );
                _saveTasks();
              }
              HarnessClient.instance.markStudioStreamFinished(streamId);
              _runScheduler();
            },
          );
      _taskSubs[taskId] = sub;
    } catch (e) {
      final current = _taskById(taskId);
      if (current != null) {
        _replaceTask(current.copyWith(status: 'error', error: '$e'));
        _saveTasks();
      }
      _runScheduler();
    }
  }

  void _retryTask(String id) {
    final task = _taskById(id);
    if (task == null || task.status == 'running') return;
    _replaceTask(
      task.copyWith(status: 'queued', clearError: true, entries: const []),
    );
    _saveTasks();
    _runScheduler();
  }

  void _removeTask(String id) {
    setState(() {
      _tasks = _tasks.where((task) => task.id != id).toList();
    });
    _saveTasks();
  }

  void _clearFinishedTasks() {
    setState(() {
      _tasks = _tasks
          .where((task) => task.status == 'queued' || task.status == 'running')
          .toList();
    });
    _saveTasks();
  }

  void _retryAllFailedTasks() {
    setState(() {
      _tasks = _tasks
          .map(
            (task) => task.status == 'error'
                ? task.copyWith(
                    status: 'queued',
                    clearError: true,
                    entries: const [],
                  )
                : task,
          )
          .toList();
    });
    _saveTasks();
    _runScheduler();
  }

  Future<void> _runGenerate({required bool editMode}) async {
    final prompt = _promptCtrl.text.trim();
    if (prompt.isEmpty) return;
    if (editMode && _editSource == null) {
      _toast('请先选择参考图');
      return;
    }
    try {
      String? inputB64;
      if (editMode) {
        final client = HttpClient();
        try {
          final req = await client.getUrl(
            Uri.parse(
              '${HarnessClient.instance.httpBase}/studio/${_editSource!.id}',
            ),
          );
          final resp = await req.close();
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            throw StateError('读取参考图失败（HTTP ${resp.statusCode}）');
          }
          final bytes = await resp.fold<List<int>>([], (a, b) => a..addAll(b));
          if (bytes.isEmpty) throw StateError('参考图为空');
          inputB64 = base64Encode(bytes);
        } finally {
          client.close(force: true);
        }
      }
      _enqueueTask({
        'mode': editMode ? 'edit' : 'generate',
        'prompt': prompt,
        if (!editMode && _negativeCtrl.text.trim().isNotEmpty)
          'negativePrompt': _negativeCtrl.text.trim(),
        'aspect': _aspect,
        'resolution': _resolution,
        'size': _resolution,
        'quality': _quality,
        'format': _format,
        'n': editMode ? 1 : _n,
        'inputImageB64': ?inputB64,
        'providerId': ?_providerId,
        if (_model != null && _model!.isNotEmpty) 'model': _model,
      });
    } catch (e) {
      if (mounted) {
        _toast('失败：$e');
      }
    }
  }

  void _toast(String message) {
    if (!mounted) return;
    showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('Studio'),
        content: Text(message),
        actions: [
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.pop(ctx),
            child: const Text('好'),
          ),
        ],
      ),
    );
  }

  void _pickEditSource() {
    final p = DawnPalette.of(context);
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.6,
        ),
        decoration: BoxDecoration(
          color: p.groupedBg,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
                child: Text(
                  '选择参考图（从图库）',
                  style: TextStyle(fontSize: 13, color: p.ink2),
                ),
              ),
              Expanded(
                child: GridView.builder(
                  padding: const EdgeInsets.all(12),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 3,
                    crossAxisSpacing: 8,
                    mainAxisSpacing: 8,
                  ),
                  itemCount: _gallery.length,
                  itemBuilder: (ctx, i) => GestureDetector(
                    onTap: () {
                      setState(() => _editSource = _gallery[i]);
                      Navigator.pop(ctx);
                    },
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.network(
                        '${HarnessClient.instance.httpBase}/studio/${_gallery[i].id}',
                        fit: BoxFit.cover,
                        errorBuilder: (ctx, e, _) =>
                            const ColoredBox(color: Color(0xFFE5E5EA)),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<String?> _askForName({String title = '新建文件夹', String initial = ''}) {
    final ctrl = TextEditingController(text: initial);
    return showCupertinoDialog<String>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text(title),
        content: Padding(
          padding: const EdgeInsets.only(top: 12),
          child: CupertinoTextField(
            controller: ctrl,
            autofocus: true,
            placeholder: '文件夹名称',
            onSubmitted: (_) {
              final value = ctrl.text.trim();
              if (value.isNotEmpty) Navigator.pop(ctx, value);
            },
          ),
        ),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () {
              final value = ctrl.text.trim();
              Navigator.pop(ctx, value.isEmpty ? null : value);
            },
            child: const Text('确定'),
          ),
        ],
      ),
    ).whenComplete(ctrl.dispose);
  }

  Future<void> _createFolder() async {
    final name = await _askForName();
    if (!mounted || name == null || name.isEmpty) return;
    if (name == '全部' || name == '未分类' || _folderNames.contains(name)) {
      _toast(name == '全部' || name == '未分类' ? '这是系统文件夹名称' : '文件夹已存在');
      return;
    }
    try {
      final remote = await HarnessClient.instance.studioCreateFolder(name);
      final nextNames = remote.isEmpty
          ? (<String>{..._folderNames, name}.toList()..sort())
          : remote;
      setState(() {
        _folderNames
          ..clear()
          ..addAll(nextNames);
      });
    } catch (_) {
      setState(() => _folderNames.add(name));
    }
    await _saveFolders();
  }

  Future<void> _renameFolder(String oldName) async {
    final name = await _askForName(title: '重命名文件夹', initial: oldName);
    if (!mounted || name == null || name.isEmpty || name == oldName) return;
    if (name == '全部' || name == '未分类' || _folderNames.contains(name)) {
      _toast(name == '全部' || name == '未分类' ? '这是系统文件夹名称' : '文件夹已存在');
      return;
    }
    List<String>? remote;
    try {
      remote = await HarnessClient.instance.studioRenameFolder(oldName, name);
    } catch (_) {
      final entries = _gallery.where((e) => e.folder == oldName).toList();
      for (final entry in entries) {
        await HarnessClient.instance.studioTag(entry.id, name, entry.tags);
      }
    }
    setState(() {
      if (remote != null) {
        _folderNames
          ..clear()
          ..addAll(remote);
      } else {
        final i = _folderNames.indexOf(oldName);
        if (i >= 0) _folderNames[i] = name;
      }
      if (_activeFolder == oldName) _activeFolder = name;
    });
    await _saveFolders();
    await _loadGallery();
  }

  Future<void> _deleteFolder(String name) async {
    final shouldDelete = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('删除“$name”？'),
        content: const Text('文件夹中的图片会保留在图库根目录。'),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (!mounted || shouldDelete != true) return;
    List<String>? remote;
    try {
      remote = await HarnessClient.instance.studioDeleteFolder(name);
    } catch (_) {
      final entries = _gallery.where((e) => e.folder == name).toList();
      for (final entry in entries) {
        await HarnessClient.instance.studioTag(entry.id, '', entry.tags);
      }
    }
    setState(() {
      if (remote != null) {
        _folderNames
          ..clear()
          ..addAll(remote);
      } else {
        _folderNames.remove(name);
      }
      if (_activeFolder == name) _activeFolder = null;
    });
    await _saveFolders();
    await _loadGallery();
  }

  void _showFolderActions(String name) {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(name),
        actions: [
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              _renameFolder(name);
            },
            child: const Text('重命名'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () {
              Navigator.pop(ctx);
              _deleteFolder(name);
            },
            child: const Text('删除文件夹'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('取消'),
        ),
      ),
    );
  }

  Future<void> _showTaskDetail(StudioTask task) async {
    final p = DawnPalette.of(context);
    final mode = task.request['mode'] == 'edit' ? '图片编辑' : '文字生图';
    final statusText = switch (task.status) {
      'queued' => '等待中',
      'running' => '生成中',
      'success' => '已完成',
      _ => '失败',
    };
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(ctx).size.height * .88,
        ),
        decoration: BoxDecoration(
          color: p.groupedBg,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
        ),
        child: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      width: 36,
                      height: 36,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: p.indigo.withValues(alpha: .14),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Icon(
                        task.status == 'success'
                            ? CupertinoIcons.checkmark_alt
                            : CupertinoIcons.sparkles,
                        color: p.indigo,
                        size: 20,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            mode,
                            style: const TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Text(
                            statusText,
                            style: TextStyle(
                              fontSize: 12,
                              color: task.status == 'error' ? iosRed : p.ink2,
                            ),
                          ),
                        ],
                      ),
                    ),
                    CupertinoButton(
                      padding: EdgeInsets.zero,
                      onPressed: () => Navigator.pop(ctx),
                      child: const Icon(
                        CupertinoIcons.xmark_circle_fill,
                        size: 24,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                if (task.entries.isNotEmpty)
                  SizedBox(
                    height: 220,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: task.entries.length,
                      separatorBuilder: (_, _) => const SizedBox(width: 10),
                      itemBuilder: (_, i) => GestureDetector(
                        onTap: () {
                          Navigator.pop(ctx);
                          _showImageDetail(task.entries[i]);
                        },
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(14),
                          child: Image.network(
                            '${HarnessClient.instance.httpBase}/studio/${task.entries[i].id}',
                            width: 220,
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                    ),
                  )
                else
                  Container(
                    height: 120,
                    width: double.infinity,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: p.cardBg,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      task.status == 'error'
                          ? (task.error ?? '生成失败')
                          : statusText,
                      maxLines: 5,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: task.status == 'error' ? iosRed : p.ink2,
                      ),
                    ),
                  ),
                const SizedBox(height: 16),
                _detailInfoRow('提示词', task.label),
                _detailInfoRow('模型', '${task.request['model'] ?? '默认模型'}'),
                _detailInfoRow(
                  '参数',
                  [
                    if (task.request['aspect'] != null) task.request['aspect'],
                    if (task.request['resolution'] != null)
                      task.request['resolution'],
                    if (task.request['quality'] != null)
                      task.request['quality'],
                    if (task.request['format'] != null)
                      '${task.request['format']}'.toUpperCase(),
                  ].whereType<String>().join(' · '),
                ),
                if (task.request['negativePrompt'] is String &&
                    (task.request['negativePrompt'] as String).isNotEmpty)
                  _detailInfoRow(
                    '负向提示词',
                    task.request['negativePrompt'] as String,
                  ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    if (task.status == 'error')
                      Expanded(
                        child: CupertinoButton.filled(
                          onPressed: () {
                            Navigator.pop(ctx);
                            _retryTask(task.id);
                          },
                          child: const Text('重试任务'),
                        ),
                      ),
                    if (task.status == 'error') const SizedBox(width: 10),
                    Expanded(
                      child: CupertinoButton(
                        color: p.cardBg,
                        onPressed: () => Navigator.pop(ctx),
                        child: const Text('关闭'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _detailInfoRow(String label, String value) {
    final p = DawnPalette.of(context);
    if (value.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11, color: p.ink2)),
          const SizedBox(height: 3),
          Text(value, style: const TextStyle(fontSize: 14, height: 1.3)),
        ],
      ),
    );
  }

  Future<void> _showImageDetail(ImageEntry entry) async {
    final p = DawnPalette.of(context);
    final transform = TransformationController();
    var zoom = 1.0;
    var copied = false;
    final dimensions = entry.width != null && entry.height != null
        ? '${entry.width}×${entry.height}'
        : '';
    final metadata = [
      entry.mode == 'edit' ? '编辑' : '生成',
      if (entry.aspect?.isNotEmpty == true) entry.aspect!,
      if (entry.resolution?.isNotEmpty == true) entry.resolution!,
      if (entry.quality?.isNotEmpty == true) entry.quality!,
      if (entry.format?.isNotEmpty == true) entry.format!.toUpperCase(),
      if (dimensions.isNotEmpty) dimensions,
    ].join(' · ');
    try {
      await Navigator.of(context).push<void>(
        CupertinoPageRoute(
          builder: (pageContext) => StatefulBuilder(
            builder: (pageContext, setPreviewState) => CupertinoPageScaffold(
              backgroundColor: p.groupedBg,
              navigationBar: CupertinoNavigationBar(
                backgroundColor: p.cardBg,
                border: Border(bottom: BorderSide(color: p.separator)),
                leading: CupertinoNavigationBarBackButton(
                  color: p.indigo,
                  previousPageTitle: '图库',
                  onPressed: () => Navigator.pop(pageContext),
                ),
                middle: Text(
                  '图片预览',
                  style: TextStyle(
                    color: p.ink,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                trailing: CupertinoButton(
                  padding: const EdgeInsets.all(5),
                  minimumSize: const Size(30, 30),
                  onPressed: () async {
                    final confirmed = await showCupertinoDialog<bool>(
                      context: pageContext,
                      builder: (dialogContext) => CupertinoAlertDialog(
                        title: const Text('删除这张图片？'),
                        content: const Text('删除后无法恢复。'),
                        actions: [
                          CupertinoDialogAction(
                            onPressed: () =>
                                Navigator.pop(dialogContext, false),
                            child: const Text('取消'),
                          ),
                          CupertinoDialogAction(
                            isDestructiveAction: true,
                            onPressed: () => Navigator.pop(dialogContext, true),
                            child: const Text('删除'),
                          ),
                        ],
                      ),
                    );
                    if (confirmed != true || !pageContext.mounted) return;
                    await HarnessClient.instance.studioDelete(entry.id);
                    if (pageContext.mounted) Navigator.pop(pageContext);
                    _loadGallery();
                  },
                  child: const Icon(
                    CupertinoIcons.trash,
                    size: 19,
                    color: iosRed,
                  ),
                ),
              ),
              child: SafeArea(
                top: false,
                child: Column(
                  children: [
                    Expanded(
                      child: Container(
                        width: double.infinity,
                        color: p.isDark
                            ? const Color(0xFF0C0D12)
                            : const Color(0xFFE9EAF0),
                        child: Stack(
                          children: [
                            Positioned.fill(
                              child: GestureDetector(
                                onDoubleTap: () {
                                  transform.value = Matrix4.identity();
                                  setPreviewState(() => zoom = 1);
                                },
                                child: InteractiveViewer(
                                  transformationController: transform,
                                  minScale: .7,
                                  maxScale: 5,
                                  boundaryMargin: const EdgeInsets.all(120),
                                  onInteractionUpdate: (_) {
                                    setPreviewState(() {
                                      zoom = transform.value
                                          .getMaxScaleOnAxis();
                                    });
                                  },
                                  child: Center(
                                    child: Image.network(
                                      '${HarnessClient.instance.httpBase}/studio/${entry.id}',
                                      fit: BoxFit.contain,
                                      errorBuilder: (_, _, _) => Icon(
                                        CupertinoIcons.photo,
                                        size: 42,
                                        color: p.ink3,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            Positioned(
                              right: 10,
                              bottom: 10,
                              child: Container(
                                height: 34,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 3,
                                ),
                                decoration: BoxDecoration(
                                  color: p.cardBg.withValues(alpha: .92),
                                  borderRadius: BorderRadius.circular(9),
                                  border: Border.all(color: p.separator),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    _previewButton(CupertinoIcons.minus, () {
                                      final next = (zoom - .25).clamp(.7, 5.0);
                                      transform.value = _zoomMatrix(next);
                                      setPreviewState(() => zoom = next);
                                    }),
                                    SizedBox(
                                      width: 42,
                                      child: Text(
                                        '${(zoom * 100).round()}%',
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          fontSize: 10,
                                          color: p.ink2,
                                        ),
                                      ),
                                    ),
                                    _previewButton(CupertinoIcons.plus, () {
                                      final next = (zoom + .25).clamp(.7, 5.0);
                                      transform.value = _zoomMatrix(next);
                                      setPreviewState(() => zoom = next);
                                    }),
                                    _previewButton(
                                      CupertinoIcons.arrow_counterclockwise,
                                      () {
                                        transform.value = Matrix4.identity();
                                        setPreviewState(() => zoom = 1);
                                      },
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                      decoration: BoxDecoration(
                        color: p.cardBg,
                        border: Border(top: BorderSide(color: p.separator)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            entry.prompt.isEmpty ? '无提示词' : entry.prompt,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13,
                              height: 1.25,
                              fontWeight: FontWeight.w600,
                              color: p.ink,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            [
                              if (entry.folder.isNotEmpty) entry.folder,
                              metadata,
                            ].where((value) => value.isNotEmpty).join(' · '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10.5, color: p.ink2),
                          ),
                          const SizedBox(height: 8),
                          SizedBox(
                            height: 34,
                            child: ListView(
                              scrollDirection: Axis.horizontal,
                              children: [
                                _previewAction(
                                  icon: copied
                                      ? CupertinoIcons.checkmark
                                      : CupertinoIcons.doc_on_doc,
                                  label: copied ? '已复制' : '复制提示词',
                                  onPressed: () async {
                                    await Clipboard.setData(
                                      ClipboardData(text: entry.prompt),
                                    );
                                    if (!pageContext.mounted) return;
                                    setPreviewState(() => copied = true);
                                    await Future<void>.delayed(
                                      const Duration(milliseconds: 1200),
                                    );
                                    if (pageContext.mounted) {
                                      setPreviewState(() => copied = false);
                                    }
                                  },
                                ),
                                const SizedBox(width: 7),
                                _previewAction(
                                  icon: CupertinoIcons.slider_horizontal_3,
                                  label: '载入参数',
                                  onPressed: () {
                                    setState(() {
                                      _applyEntryParams(entry);
                                      _view = 0;
                                    });
                                    Navigator.pop(pageContext);
                                  },
                                ),
                                const SizedBox(width: 7),
                                _previewAction(
                                  icon: CupertinoIcons.arrow_clockwise,
                                  label: '重新生成',
                                  onPressed: () {
                                    setState(() {
                                      _applyEntryParams(entry);
                                      _view = 0;
                                    });
                                    Navigator.pop(pageContext);
                                    _runGenerate(editMode: false);
                                  },
                                ),
                                const SizedBox(width: 7),
                                _previewAction(
                                  icon: CupertinoIcons.wand_stars,
                                  label: '用作输入',
                                  onPressed: () {
                                    setState(() {
                                      _editSource = entry;
                                      _promptCtrl.clear();
                                      _providerId = entry.providerId;
                                      _model = entry.model;
                                      _providerName = entry.providerId == null
                                          ? ''
                                          : '原图';
                                      _view = 1;
                                    });
                                    Navigator.pop(pageContext);
                                  },
                                ),
                                const SizedBox(width: 7),
                                _previewAction(
                                  icon: CupertinoIcons.folder,
                                  label: '整理',
                                  onPressed: () =>
                                      _showImageOrganizer(pageContext, entry),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    } finally {
      transform.dispose();
    }
  }

  Widget _previewButton(IconData icon, VoidCallback onPressed) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: const EdgeInsets.all(4),
      minimumSize: const Size(27, 27),
      onPressed: onPressed,
      child: Icon(icon, size: 15, color: p.ink),
    );
  }

  Widget _previewAction({
    required IconData icon,
    required String label,
    required VoidCallback onPressed,
  }) {
    final p = DawnPalette.of(context);
    return Container(
      decoration: BoxDecoration(
        color: p.groupedBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: p.separator),
      ),
      child: CupertinoButton(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        minimumSize: const Size(0, 32),
        onPressed: onPressed,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: p.indigo),
            const SizedBox(width: 5),
            Text(
              label,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w500,
                color: p.ink,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showImageOrganizer(
    BuildContext pageContext,
    ImageEntry entry,
  ) async {
    final p = DawnPalette.of(pageContext);
    final tagCtrl = TextEditingController(text: entry.tags.join(', '));
    final folderCtrl = TextEditingController(text: entry.folder);
    try {
      await showCupertinoModalPopup<void>(
        context: pageContext,
        builder: (sheetContext) => Container(
          decoration: BoxDecoration(
            color: p.groupedBg,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
          ),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '整理图片',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: p.ink,
                          ),
                        ),
                      ),
                      CupertinoButton(
                        padding: const EdgeInsets.all(4),
                        minimumSize: const Size(28, 28),
                        onPressed: () => Navigator.pop(sheetContext),
                        child: Icon(
                          CupertinoIcons.xmark_circle_fill,
                          size: 21,
                          color: p.ink3,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(child: _sheetField(folderCtrl, '文件夹')),
                      const SizedBox(width: 10),
                      Expanded(child: _sheetField(tagCtrl, '标签（逗号分隔）')),
                    ],
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    height: 36,
                    child: CupertinoButton(
                      color: p.indigo,
                      padding: EdgeInsets.zero,
                      onPressed: () async {
                        final folder = folderCtrl.text.trim();
                        if (folder == '全部' || folder == '未分类') {
                          _toast('请使用自定义文件夹名称');
                          return;
                        }
                        await HarnessClient.instance.studioTag(
                          entry.id,
                          folder,
                          tagCtrl.text
                              .split(',')
                              .map((tag) => tag.trim())
                              .where((tag) => tag.isNotEmpty)
                              .toList(),
                        );
                        if (folder.isNotEmpty &&
                            !_folderNames.contains(folder)) {
                          setState(() => _folderNames.add(folder));
                          await _saveFolders();
                        }
                        if (sheetContext.mounted) {
                          Navigator.pop(sheetContext);
                        }
                        _loadGallery();
                      },
                      child: const Text(
                        '保存更改',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFFFFFFFF),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    } finally {
      tagCtrl.dispose();
      folderCtrl.dispose();
    }
  }

  Matrix4 _zoomMatrix(double value) {
    return Matrix4.identity()
      ..setEntry(0, 0, value)
      ..setEntry(1, 1, value)
      ..setEntry(2, 2, value);
  }

  Widget _sheetField(TextEditingController ctrl, String label) {
    final p = DawnPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 11, color: p.ink2)),
        const SizedBox(height: 4),
        CupertinoTextField(
          controller: ctrl,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: p.cardBg,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: p.separator),
          ),
          style: const TextStyle(fontSize: 13),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final activeTaskCount = _tasks
        .where((task) => task.status == 'queued' || task.status == 'running')
        .length;
    final queueLabel = activeTaskCount > 0 ? '队列 ($activeTaskCount)' : '队列';
    return IosScreen(
      navBar: IosNavBar(
        actions: [
          ModelPickerChip(
            label: _model == null || _model!.isEmpty
                ? (_providerName.isEmpty ? '默认模型' : '$_providerName · 默认')
                : (_providerName.isEmpty
                      ? _model!
                      : '$_providerName · $_model'),
            onTap: () => showModelPickerSheet(
              context,
              title: '生图供应商与模型',
              imageOnly: true,
              imageMode: _view == 1 ? 'edit' : 'generate',
              selectedProviderId: _providerId,
              selectedModel: _model,
              onSelected: (pid, model, pname) => setState(() {
                _providerId = pid;
                _model = model;
                _providerName = pname ?? '';
              }),
            ),
          ),
          if (_view == 2)
            IosIconButton(icon: CupertinoIcons.refresh, onPressed: _loadGallery)
          else if (_view == 3)
            IosIconButton(icon: CupertinoIcons.refresh, onPressed: _loadTasks),
        ],
        bottom: Padding(
          padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
          child: CupertinoSlidingSegmentedControl<int>(
            groupValue: _view,
            children: {
              0: const Padding(
                padding: EdgeInsets.symmetric(vertical: 5),
                child: Text('生成', style: TextStyle(fontSize: 13)),
              ),
              1: const Padding(
                padding: EdgeInsets.symmetric(vertical: 5),
                child: Text('编辑', style: TextStyle(fontSize: 13)),
              ),
              2: const Padding(
                padding: EdgeInsets.symmetric(vertical: 5),
                child: Text('图库', style: TextStyle(fontSize: 13)),
              ),
              3: Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Text(queueLabel, style: const TextStyle(fontSize: 13)),
              ),
            },
            onValueChanged: (v) => setState(() => _view = v ?? 0),
          ),
        ),
      ),
      child: _view == 0
          ? _buildGenerateView()
          : _view == 1
          ? _buildEditView()
          : _view == 2
          ? _buildLibraryView()
          : _buildQueueView(),
    );
  }

  // ---------- 生成 ----------

  Widget _buildGenerateView() {
    final p = DawnPalette.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(0, 4, 0, 20),
      children: [
        IosSection(
          header: '生成参数',
          children: [
            Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  CupertinoTextField(
                    controller: _promptCtrl,
                    maxLines: 3,
                    minLines: 2,
                    placeholder: '描述你想要的图像…',
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: p.groupedBg,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: p.separator),
                    ),
                    style: const TextStyle(fontSize: 15, letterSpacing: -0.3),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: CupertinoButton(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(28, 28),
                      onPressed: () => _showPromptOptimizer(isNegative: false),
                      child: const Text(
                        '✨ AI优化',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  CupertinoTextField(
                    controller: _negativeCtrl,
                    placeholder: '负向提示词（不希望出现的元素）',
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: p.groupedBg,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: p.separator),
                    ),
                    style: const TextStyle(fontSize: 13),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: CupertinoButton(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(28, 28),
                      onPressed: () => _showPromptOptimizer(isNegative: true),
                      child: const Text(
                        '✨ AI优化',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  _paramRow(
                    '比例',
                    _aspects,
                    _aspect,
                    (v) => setState(() => _aspect = v),
                  ),
                  const SizedBox(height: 8),
                  _paramRow(
                    '分辨率',
                    _resolutions,
                    _resolution,
                    (v) => setState(() => _resolution = v),
                  ),
                  const SizedBox(height: 8),
                  _paramRow(
                    '质量',
                    _qualities,
                    _quality,
                    (v) => setState(() => _quality = v),
                  ),
                  const SizedBox(height: 8),
                  _paramRow(
                    '格式',
                    _formats,
                    _format,
                    (v) => setState(() => _format = v),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Text('数量', style: TextStyle(fontSize: 12, color: p.ink2)),
                      const SizedBox(width: 8),
                      for (var i = 1; i <= 4; i++)
                        Padding(
                          padding: const EdgeInsets.only(right: 6),
                          child: GestureDetector(
                            onTap: () => setState(() => _n = i),
                            child: Container(
                              width: 30,
                              height: 30,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: _n == i ? iosBlue : p.groupedBg,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                '$i',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w600,
                                  color: _n == i
                                      ? const Color(0xFFFFFFFF)
                                      : p.ink,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SizedBox(
            width: double.infinity,
            child: CupertinoButton.filled(
              onPressed: () => _runGenerate(editMode: false),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(CupertinoIcons.sparkles, size: 15),
                  const SizedBox(width: 6),
                  Text(
                    _tasks.any(
                          (task) =>
                              task.status == 'queued' ||
                              task.status == 'running',
                        )
                        ? '加入队列'
                        : '开始生成',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  // ---------- 编辑 ----------

  Widget _buildEditView() {
    final p = DawnPalette.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(0, 4, 0, 20),
      children: [
        IosSection(
          header: '编辑参数',
          children: [
            Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GestureDetector(
                    onTap: _pickEditSource,
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: p.groupedBg,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: p.separator),
                      ),
                      child: Row(
                        children: [
                          if (_editSource != null)
                            ClipRRect(
                              borderRadius: BorderRadius.circular(6),
                              child: Image.network(
                                '${HarnessClient.instance.httpBase}/studio/${_editSource!.id}',
                                width: 52,
                                height: 52,
                                fit: BoxFit.cover,
                                errorBuilder: (ctx, e, _) =>
                                    const SizedBox(width: 52, height: 52),
                              ),
                            )
                          else
                            Icon(
                              CupertinoIcons.photo_on_rectangle,
                              size: 32,
                              color: p.ink2,
                            ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              _editSource == null
                                  ? '点按从图库选择参考图'
                                  : _editSource!.prompt,
                              style: const TextStyle(fontSize: 13),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          Icon(
                            CupertinoIcons.chevron_forward,
                            size: 14,
                            color: p.ink2,
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  CupertinoTextField(
                    controller: _promptCtrl,
                    maxLines: 3,
                    minLines: 2,
                    placeholder: '描述如何修改这张图…',
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: p.groupedBg,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: p.separator),
                    ),
                    style: const TextStyle(fontSize: 15, letterSpacing: -0.3),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: CupertinoButton(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(28, 28),
                      onPressed: () => _showPromptOptimizer(isNegative: false),
                      child: const Text(
                        '✨ AI优化',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  _paramRow(
                    '比例',
                    _aspects,
                    _aspect,
                    (v) => setState(() => _aspect = v),
                  ),
                  const SizedBox(height: 8),
                  _paramRow(
                    '质量',
                    _qualities,
                    _quality,
                    (v) => setState(() => _quality = v),
                  ),
                  const SizedBox(height: 8),
                  _paramRow(
                    '格式',
                    _formats,
                    _format,
                    (v) => setState(() => _format = v),
                  ),
                ],
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SizedBox(
            width: double.infinity,
            child: CupertinoButton.filled(
              onPressed: () => _runGenerate(editMode: true),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(CupertinoIcons.wand_stars, size: 15),
                  const SizedBox(width: 6),
                  Text(
                    _tasks.any(
                          (task) =>
                              task.status == 'queued' ||
                              task.status == 'running',
                        )
                        ? '加入队列'
                        : '开始编辑',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  // ---------- 图库 ----------

  Widget _buildLibraryView() {
    final p = DawnPalette.of(context);
    final folders = <String>{
      ..._folderNames,
      ..._gallery.map((entry) => entry.folder).where((name) => name.isNotEmpty),
    }.toList()..sort();
    final visible = _activeFolder == null
        ? _gallery
        : _gallery.where((entry) => entry.folder == _activeFolder).toList();
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 4),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '图库',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      _activeFolder == null
                          ? '所有创作'
                          : (_activeFolder!.isEmpty ? '未分类' : _activeFolder!),
                      style: TextStyle(fontSize: 12, color: p.ink2),
                    ),
                  ],
                ),
              ),
              Text(
                '${visible.length} 张',
                style: TextStyle(fontSize: 12, color: p.ink2),
              ),
              const SizedBox(width: 4),
              if (_activeFolder != null && _activeFolder!.isNotEmpty)
                IosIconButton(
                  icon: CupertinoIcons.ellipsis_circle,
                  tooltip: '文件夹操作',
                  onPressed: () => _showFolderActions(_activeFolder!),
                ),
              IosIconButton(
                icon: CupertinoIcons.folder_badge_plus,
                tooltip: '新建文件夹',
                onPressed: _createFolder,
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
          child: CupertinoSearchTextField(
            controller: _searchCtrl,
            placeholder: '搜索提示词',
            onSubmitted: (v) {
              setState(() => _search = v.trim());
              _loadGallery();
            },
            onSuffixTap: () {
              _searchCtrl.clear();
              setState(() => _search = '');
              _loadGallery();
            },
          ),
        ),
        SizedBox(
          height: 54,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
            scrollDirection: Axis.horizontal,
            children: [
              _folderChip(
                '全部',
                _activeFolder == null,
                () => setState(() => _activeFolder = null),
                count: _gallery.length,
              ),
              const SizedBox(width: 8),
              _folderChip(
                '未分类',
                _activeFolder == '',
                () => setState(() => _activeFolder = ''),
                count: _gallery.where((entry) => entry.folder.isEmpty).length,
              ),
              for (final name in folders) ...[
                const SizedBox(width: 8),
                _folderChip(
                  name,
                  _activeFolder == name,
                  () => setState(() => _activeFolder = name),
                  onLongPress: () => _showFolderActions(name),
                  count: _gallery.where((entry) => entry.folder == name).length,
                ),
              ],
            ],
          ),
        ),
        Expanded(
          child: visible.isEmpty
              ? IosEmptyHint(
                  icon: _gallery.isEmpty
                      ? CupertinoIcons.photo_on_rectangle
                      : CupertinoIcons.folder,
                  title: _gallery.isEmpty
                      ? '还没有图像'
                      : (_activeFolder == '' ? '未分类文件夹为空' : '此文件夹暂无图片'),
                  subtitle: _gallery.isEmpty
                      ? '去「生成」或「编辑」创作一张吧'
                      : '在图片详情中移动图片到这里',
                )
              : GridView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    crossAxisSpacing: 12,
                    mainAxisSpacing: 12,
                    childAspectRatio: .79,
                  ),
                  itemCount: visible.length,
                  itemBuilder: (ctx, i) => _ImageCard(
                    entry: visible[i],
                    onOpen: () => _showImageDetail(visible[i]),
                    onDelete: () async {
                      await HarnessClient.instance.studioDelete(visible[i].id);
                      _loadGallery();
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _folderChip(
    String label,
    bool selected,
    VoidCallback onTap, {
    VoidCallback? onLongPress,
    int? count,
  }) {
    final p = DawnPalette.of(context);
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? p.indigo : p.cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: selected ? p.indigo : p.separator),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              label == '未分类' ? CupertinoIcons.tray : CupertinoIcons.folder_fill,
              size: 14,
              color: selected ? Colors.white : p.ink2,
            ),
            const SizedBox(width: 5),
            Text(
              count == null ? label : '$label  $count',
              style: TextStyle(
                fontSize: 12,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                color: selected ? Colors.white : p.ink,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildQueueView() {
    final p = DawnPalette.of(context);
    final failedCount = _tasks.where((task) => task.status == 'error').length;
    final hasFinished = _tasks.any(
      (task) => task.status == 'success' || task.status == 'error',
    );
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
          child: Row(
            children: [
              Text(
                '生成队列',
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 10),
              Row(
                children: [
                  CupertinoButton(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(24, 24),
                    onPressed: _maxConcurrentTasks <= 1
                        ? null
                        : () => _setConcurrency(_maxConcurrentTasks - 1),
                    child: const Icon(CupertinoIcons.minus, size: 14),
                  ),
                  Text(
                    '$_maxConcurrentTasks 并发',
                    style: const TextStyle(fontSize: 12),
                  ),
                  CupertinoButton(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(24, 24),
                    onPressed: _maxConcurrentTasks >= 8
                        ? null
                        : () => _setConcurrency(_maxConcurrentTasks + 1),
                    child: const Icon(CupertinoIcons.plus, size: 14),
                  ),
                ],
              ),
              const Spacer(),
              if (failedCount > 0)
                CupertinoButton(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(28, 28),
                  onPressed: _retryAllFailedTasks,
                  child: Text(
                    '重试失败 ($failedCount)',
                    style: const TextStyle(fontSize: 12, color: iosRed),
                  ),
                ),
              if (hasFinished)
                CupertinoButton(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(28, 28),
                  onPressed: _clearFinishedTasks,
                  child: Text(
                    '清理完成',
                    style: TextStyle(fontSize: 12, color: p.ink2),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: _tasks.isEmpty
              ? const IosEmptyHint(
                  icon: CupertinoIcons.list_bullet,
                  title: '队列为空',
                  subtitle: '生成、编辑或对话触发的绘图任务会显示在这里',
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                  itemCount: _tasks.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (ctx, index) {
                    final task = _tasks[index];
                    final statusText = switch (task.status) {
                      'queued' => '等待中',
                      'running' => '生成中',
                      'success' => '已完成',
                      _ => '失败',
                    };
                    final mode = task.request['mode'] == 'edit' ? '编辑' : '生成';
                    return GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => _showTaskDetail(task),
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: p.cardBg,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(
                            color: task.status == 'error'
                                ? iosRed.withValues(alpha: 0.4)
                                : p.separator,
                          ),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (task.request['inputImageB64'] is String)
                              ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: Image.memory(
                                  base64Decode(
                                    (task.request['inputImageB64'] as String)
                                        .split(',')
                                        .last,
                                  ),
                                  width: 40,
                                  height: 40,
                                  fit: BoxFit.cover,
                                  errorBuilder: (_, _, _) => Container(
                                    width: 40,
                                    height: 40,
                                    color: p.groupedBg,
                                  ),
                                ),
                              )
                            else if (task.entries.isNotEmpty)
                              ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: Image.network(
                                  '${HarnessClient.instance.httpBase}/studio/${task.entries.first.id}',
                                  width: 40,
                                  height: 40,
                                  fit: BoxFit.cover,
                                  errorBuilder: (_, _, _) => Container(
                                    width: 40,
                                    height: 40,
                                    color: p.groupedBg,
                                  ),
                                ),
                              )
                            else
                              Container(
                                width: 40,
                                height: 40,
                                alignment: Alignment.center,
                                decoration: BoxDecoration(
                                  color: p.groupedBg,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Icon(
                                  mode == '编辑'
                                      ? CupertinoIcons.pencil
                                      : CupertinoIcons.sparkles,
                                  size: 18,
                                  color: p.indigo,
                                ),
                              ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    task.label,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${task.createdByAgent ? 'AI · ' : ''}$mode · $statusText',
                                    style: TextStyle(
                                      fontSize: 11,
                                      color: task.status == 'success'
                                          ? const Color(0xFF34C759)
                                          : task.status == 'error'
                                          ? iosRed
                                          : p.ink2,
                                    ),
                                  ),
                                  if (task.error?.isNotEmpty == true) ...[
                                    const SizedBox(height: 4),
                                    Text(
                                      task.error!,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 11,
                                        color: iosRed,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                            if (task.status == 'error')
                              CupertinoButton(
                                padding: EdgeInsets.zero,
                                minimumSize: const Size(28, 28),
                                onPressed: () => _retryTask(task.id),
                                child: const Icon(
                                  CupertinoIcons.arrow_clockwise,
                                  size: 16,
                                ),
                              ),
                            if (task.status != 'running')
                              CupertinoButton(
                                padding: EdgeInsets.zero,
                                minimumSize: const Size(28, 28),
                                onPressed: () => _removeTask(task.id),
                                child: const Icon(
                                  CupertinoIcons.xmark,
                                  size: 16,
                                ),
                              ),
                            Icon(
                              CupertinoIcons.chevron_right,
                              size: 14,
                              color: p.ink3,
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _paramRow(
    String label,
    List<String> options,
    String current,
    ValueChanged<String> onChanged,
  ) {
    // 窄屏（手机）下分段控件会溢出，改用可换行的选择芯片
    final p = DawnPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 12, color: p.ink2)),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final o in options)
                GestureDetector(
                  onTap: () => onChanged(o),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: current == o ? iosBlue : p.groupedBg,
                      borderRadius: BorderRadius.circular(8),
                      border: current == o
                          ? null
                          : Border.all(color: p.separator),
                    ),
                    child: Text(
                      o,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: current == o
                            ? FontWeight.w600
                            : FontWeight.w400,
                        color: current == o ? const Color(0xFFFFFFFF) : p.ink,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ImageCard extends StatelessWidget {
  const _ImageCard({
    required this.entry,
    required this.onOpen,
    required this.onDelete,
  });

  final ImageEntry entry;
  final VoidCallback onOpen;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return GestureDetector(
      onTap: onOpen,
      child: Container(
        decoration: BoxDecoration(
          color: p.cardBg,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: p.separator),
          boxShadow: [
            BoxShadow(
              color: p.ink.withValues(alpha: .06),
              blurRadius: 10,
              offset: Offset(0, 3),
            ),
          ],
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ColoredBox(
                    color: p.groupedBg,
                    child: Image.network(
                      '${HarnessClient.instance.httpBase}/studio/${entry.id}',
                      fit: BoxFit.cover,
                      errorBuilder: (ctx, e, _) => const Center(
                        child: Icon(
                          CupertinoIcons.photo,
                          size: 30,
                          color: Color(0xFFC7C7CC),
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    top: 8,
                    right: 8,
                    child: GestureDetector(
                      onTap: onDelete,
                      child: Container(
                        width: 28,
                        height: 28,
                        decoration: BoxDecoration(
                          color: const Color(0xCC000000),
                          borderRadius: BorderRadius.circular(9),
                        ),
                        child: const Icon(
                          CupertinoIcons.trash,
                          size: 14,
                          color: Color(0xFFFFFFFF),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 8, 9),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          entry.prompt,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            height: 1.2,
                          ),
                        ),
                        const SizedBox(height: 5),
                        Row(
                          children: [
                            Icon(
                              CupertinoIcons.folder,
                              size: 11,
                              color: p.ink3,
                            ),
                            const SizedBox(width: 3),
                            Expanded(
                              child: Text(
                                entry.folder.isEmpty ? '未分类' : entry.folder,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 10, color: p.ink2),
                              ),
                            ),
                            if (entry.tags.isNotEmpty) ...[
                              const SizedBox(width: 6),
                              Icon(CupertinoIcons.tag, size: 11, color: p.ink3),
                              const SizedBox(width: 2),
                              Flexible(
                                child: Text(
                                  entry.tags.first,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(fontSize: 10, color: p.ink2),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 4),
                  Icon(CupertinoIcons.chevron_right, size: 14, color: p.ink3),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
