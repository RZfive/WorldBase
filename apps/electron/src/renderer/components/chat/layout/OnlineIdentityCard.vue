<script setup lang="ts">
import { computed } from 'vue'
import type { OnlineGroupBackground } from '../../../../shared/online-group-types.js'
import {
  onlineGroupBackgroundGradient,
  profileInitial
} from './online-group-profile'

interface IdentityProfile {
  displayName: string
  avatar?: string
  background?: OnlineGroupBackground
  tags?: string[]
}

const props = defineProps<{
  profile: IdentityProfile
  editable?: boolean
  compact?: boolean
  badge?: string
  badgeKind?: 'you' | 'owner' | 'agent'
  presence?: 'online' | 'offline'
  /**
   * Member list only: the whole card folds the Agents this human brought
   * along. `agentCount` labels the fold; `expanded` is its controlled state.
   */
  toggleable?: boolean
  agentCount?: number
  expanded?: boolean
}>()

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'toggle'): void
}>()

// On a toggleable card a click belongs to the fold, so editing the identity is
// reached through the pencil alone instead of the avatar and name.
const editOnClick = computed(() => Boolean(props.editable) && !props.toggleable)

const background = computed(() => onlineGroupBackgroundGradient(props.profile.background))
const avatarText = computed(() => props.profile.avatar?.trim() || profileInitial(props.profile.displayName))
const visibleTags = computed(() => (props.profile.tags || []).slice(0, props.compact ? 2 : 4))
const extraTagCount = computed(() => Math.max(0, (props.profile.tags || []).length - visibleTags.value.length))
</script>

<template>
  <div
    class="identity-card"
    :class="{
      compact: props.compact,
      toggleable: props.toggleable,
      folded: props.toggleable && !props.expanded
    }"
    :style="{ background }"
    :role="props.toggleable ? 'button' : undefined"
    :tabindex="props.toggleable ? 0 : undefined"
    :aria-expanded="props.toggleable ? Boolean(props.expanded) : undefined"
    @click="props.toggleable && emit('toggle')"
    @keydown.enter.self.prevent="props.toggleable && emit('toggle')"
    @keydown.space.self.prevent="props.toggleable && emit('toggle')"
  >
    <component
      :is="editOnClick ? 'button' : 'span'"
      class="identity-avatar"
      :type="editOnClick ? 'button' : undefined"
      :title="editOnClick ? $t('onlineGroups.editIdentity') : undefined"
      @click="editOnClick && emit('edit')"
    >
      <img v-if="avatarText.startsWith('data:image/')" :src="avatarText" alt="" />
      <span v-else>{{ avatarText }}</span>
    </component>
    <div class="identity-main">
      <div class="identity-name-row">
        <component
          :is="editOnClick ? 'button' : 'span'"
          class="identity-name"
          :type="editOnClick ? 'button' : undefined"
          :title="editOnClick ? $t('onlineGroups.editIdentity') : undefined"
          @click="editOnClick && emit('edit')"
        >{{ props.profile.displayName }}</component>
        <span v-if="props.badge" class="identity-badge" :class="props.badgeKind">{{ props.badge }}</span>
        <span v-if="props.presence" class="identity-presence" :class="props.presence">
          <span aria-hidden="true" />
          {{ $t(`onlineGroups.${props.presence}`) }}
        </span>
      </div>
      <div v-if="visibleTags.length || (props.editable && !props.toggleable)" class="identity-tags">
        <span v-for="tag in visibleTags" :key="tag" class="identity-tag">{{ tag }}</span>
        <span v-if="extraTagCount > 0" class="identity-tag more">+{{ extraTagCount }}</span>
        <span v-if="props.editable && !props.toggleable && visibleTags.length === 0" class="identity-tag add">{{ $t('onlineGroups.addTags') }}</span>
      </div>
    </div>
    <!-- Fold affordance: how many Agents hang off this human, and which way they go. -->
    <span v-if="props.toggleable" class="identity-fold">
      <span v-if="props.agentCount" class="identity-fold-count">{{ props.agentCount }}</span>
      <svg
        class="identity-fold-caret"
        width="10"
        height="10"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M4.5 6.25L8 9.75l3.5-3.5" />
      </svg>
    </span>
    <button
      v-if="props.editable"
      type="button"
      class="identity-edit-hint"
      :title="$t('onlineGroups.editIdentity')"
      :aria-label="$t('onlineGroups.editIdentity')"
      @click.stop="emit('edit')"
    >✎</button>
  </div>
</template>

<style scoped>
.identity-card {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--app-border-strong) 75%, transparent);
  border-radius: 13px;
  color: var(--app-text-strong);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.identity-card.compact {
  gap: 8px;
  padding: 7px 8px;
  border-radius: 11px;
}
/* Fold trigger (member list). The card reads as one pressable row: the pencil
   inside stays an independent button, so the click that folds never reaches it. */
.identity-card.toggleable {
  user-select: none;
  cursor: pointer;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.identity-card.toggleable:hover {
  border-color: rgba(255, 255, 255, 0.42);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 3px rgba(255, 255, 255, 0.08);
}
.identity-card.toggleable:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}
.identity-fold {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  color: inherit;
}
.identity-fold-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 19px;
  height: 17px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.19);
  font-size: 0.61rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.identity-fold-caret {
  opacity: 0.78;
  transition: transform 0.16s ease;
}
.identity-card.folded .identity-fold-caret {
  transform: rotate(-90deg);
}
.identity-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.22);
  color: inherit;
  cursor: inherit;
  font: inherit;
  font-size: 21px;
  overflow: hidden;
  backdrop-filter: blur(6px);
}
.compact .identity-avatar {
  width: 30px;
  height: 30px;
  flex-basis: 30px;
  border-radius: 9px;
  font-size: 16px;
}
button.identity-avatar {
  cursor: pointer;
}
.identity-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.identity-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.identity-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.identity-name {
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: inherit;
  font: inherit;
  font-size: 0.84rem;
  font-weight: 750;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button.identity-name {
  cursor: pointer;
}
.compact .identity-name {
  font-size: 0.76rem;
}
.identity-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.19);
  color: inherit;
  font-size: 0.6rem;
  font-weight: 650;
}
.identity-badge.owner {
  background: color-mix(in srgb, #f0b43c 24%, rgba(255, 255, 255, 0.16));
}
.identity-presence {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--app-text-strong) 70%, transparent);
  font-size: 0.58rem;
  font-weight: 600;
}
.identity-presence > span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--app-text-faint);
}
.identity-presence.online {
  color: #8de2ad;
}
.identity-presence.online > span {
  background: #3bb273;
  box-shadow: 0 0 0 2px color-mix(in srgb, #3bb273 15%, transparent);
}
.identity-tags {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}
.identity-tag {
  max-width: 92px;
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  color: color-mix(in srgb, var(--app-text-strong) 86%, transparent);
  font-size: 0.62rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity-tag.more,
.identity-tag.add {
  color: color-mix(in srgb, var(--app-text-strong) 70%, transparent);
}
.identity-edit-hint {
  flex: 0 0 auto;
  padding: 0;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--app-text-strong) 62%, transparent);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
/* On a fold trigger the pencil is the only way in to identity editing, so it
   gets its own hit area to read as a separate control from the card. */
.toggleable .identity-edit-hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  transition: background 0.16s ease, color 0.16s ease;
}
.toggleable .identity-edit-hint:hover {
  background: rgba(255, 255, 255, 0.2);
  color: inherit;
}
</style>
