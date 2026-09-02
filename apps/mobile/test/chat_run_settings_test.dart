import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/providers.dart';

void main() {
  test('chat run settings match Electron defaults and bounds', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);

    expect(container.read(chatSwitchesProvider).reasoningStrength, 'max');
    expect(container.read(chatSwitchesProvider).temperature, isNull);

    final notifier = container.read(chatSwitchesProvider.notifier);
    notifier.setReasoningStrength('low');
    notifier.setTemperature(3);

    expect(container.read(chatSwitchesProvider).reasoningStrength, 'low');
    expect(container.read(chatSwitchesProvider).temperature, 2);

    notifier.setReasoningStrength('unsupported');
    notifier.setTemperature(-1);

    expect(container.read(chatSwitchesProvider).reasoningStrength, 'low');
    expect(container.read(chatSwitchesProvider).temperature, 0);
  });
}
