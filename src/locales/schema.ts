/**
 * The message schema is derived from the zh-CN catalog so both locale files are
 * structurally checked against the same shape. Import this type-only module to
 * annotate the en-US catalog.
 */
import type zhCN from './zh-CN/index'

export type MessageSchema = typeof zhCN
