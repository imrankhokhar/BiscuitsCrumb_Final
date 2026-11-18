import {
  ADMIN_PERMISSIONS,
  PERMISSIONS,
  USER_PERMISSIONS,
} from '../../server/src/lib/permissions.ts'
import { matchCashline } from '../../server/src/lib/cashlineMatch.ts'
import type {
  AppNotification,
  AppSettings,
  CurrencyOption,
  EmailLog,
  EmailTemplate,
  EmailUser,
  Item,
  ManagedUser,
  PayableRow,
  PaymentStatus,
  PendingPayment,
  PermissionRow,
  RoleRow,
  ThemePreference,
  User,
} from '../types.ts'
import { num, personName, round2, splitName, text } from './money.ts'
import { parseStatement } from './statement.ts'
import {
  ATTACHMENTS_BUCKET,
  COMPANY_ASSETS_BUCKET,
  ITEM_IMAGES_BUCKET,
  PROFILE_IMAGES_BUCKET,
  rememberSession,
  signupClient,
  supabase,
} from './supabase.ts'

type Db = Record<string, unknown>

function nowIso() {
  return new Date().toISOString()
}

function raise(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

function one<T>(result: { data: T | null; error: { message: string } | null }, label: string): T {
  raise(result.error)
  if (result.data == null) throw new Error(`${label} failed`)
  return result.data
}

function roleCode(code: string) {
  const lower = code.toLowerCase()
  return lower === 'admin' || lower === 'user' ? lower : code
}

function appRole(code: string): User['role'] {
  return code.toLowerCase() === 'admin' ? 'admin' : 'user'
}

function themeOf(value: unknown): ThemePreference {
  const theme = text(value)
  return theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system'
}

function fallbackPermissions(code: string): string[] {
  const lower = code.toLowerCase()
  if (lower === 'admin') return [...ADMIN_PERMISSIONS]
  if (lower === 'user') return [...USER_PERMISSIONS]
  return []
}

function formFile(form: FormData, key: string) {
  const value = form.get(key)
  return value instanceof File && value.size > 0 ? value : null
}

function formText(form: FormData, key: string) {
  const value = form.get(key)
  return typeof value === 'string' ? value : ''
}

async function requireUserId() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error(error.message)
  if (data.session?.access_token) rememberSession(data.session.access_token)
  const id = data.session?.user.id
  if (!id) throw new Error('Not signed in')
  return id
}

async function uploadFile(bucket: string, file: File, folder?: string) {
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : ''
  const name = `${crypto.randomUUID()}${ext}`
  const path = folder ? `${folder}/${name}` : name
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file.type || undefined,
  })
  if (error) throw new Error(error.message)
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

async function codesForRole(roleId: string, code: string) {
  const links = await supabase.from('RolePermission').select('PermissionId').eq('roleId', roleId)
  raise(links.error)
  const ids = (links.data ?? []).map((row) => String(row.PermissionId)).filter(Boolean)
  if (ids.length === 0) return fallbackPermissions(code)
  const perms = await supabase.from('Permissions').select('code').in('id', ids)
  raise(perms.error)
  const codes = (perms.data ?? []).map((row) => String(row.code))
  return codes.length ? codes : fallbackPermissions(code)
}

async function loadUser(id: string): Promise<User> {
  const user = await supabase.from('Users').select('*').eq('id', id).maybeSingle()
  raise(user.error)
  if (!user.data) throw new Error('Profile not found')
  if (user.data.isActive === false) throw new Error('This account is disabled')
  const role = await supabase.from('Roles').select('id,code,name').eq('id', user.data.roleId).maybeSingle()
  raise(role.error)
  if (!role.data) throw new Error('Role not found')
  const permissions = await codesForRole(String(role.data.id), String(role.data.code))
  return {
    id,
    name: personName(text(user.data.firstname), text(user.data.lastname), String(user.data.email)),
    email: String(user.data.email),
    role: appRole(String(role.data.code)),
    themePreference: themeOf(user.data.themePreference),
    avatarUrl: text(user.data.avatarUrl),
    permissions,
  }
}

const defaultBranding = { appName: 'Excelorithm', tagline: 'Vending Machine', logoUrl: '' }

async function loadSetting(): Promise<Db | null> {
  const { data, error } = await supabase.from('Setting').select('*').limit(1)
  raise(error)
  return (data?.[0] as Db | undefined) ?? null
}

type AppSounds = {
  notificationSoundEnabled: boolean
  notificationSoundUrl: string
  paymentSoundUrl: string
  unselectSoundUrl: string
}

function soundsFrom(row: Db): AppSounds {
  return {
    notificationSoundEnabled: row.notificationSoundEnabled !== false,
    notificationSoundUrl: text(row.notificationSoundUrl),
    paymentSoundUrl: text(row.paymentSoundUrl),
    unselectSoundUrl: text(row.unselectedSoundUrl),
  }
}

/** Sound files only. The full Setting row also stores the SMTP password. */
async function loadSounds(): Promise<AppSounds | null> {
  const rpc = await supabase.rpc('app_sounds')
  const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as Db | null
  if (!rpc.error && row) return soundsFrom(row)
  try {
    const setting = await loadSetting()
    return setting ? soundsFrom(setting) : null
  } catch {
    return null
  }
}

/** Name, tagline, and logo only. The full Setting row also stores the SMTP password. */
async function loadBranding(): Promise<{ appName: string; tagline: string; logoUrl: string }> {
  const rpc = await supabase.rpc('branding')
  const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as Db | null
  if (rpc.error || !row) return defaultBranding
  return {
    appName: text(row.appName) || defaultBranding.appName,
    tagline: text(row.tagline) || defaultBranding.tagline,
    logoUrl: text(row.logoUrl),
  }
}

async function defaultCurrencyId() {
  const { data, error } = await supabase.from('Currency').select('id,code,isActive')
  raise(error)
  const rows = data ?? []
  const pick =
    rows.find((row) => row.code === 'PKR' && row.isActive) ??
    rows.find((row) => row.isActive) ??
    rows[0]
  if (!pick) throw new Error('No currency configured')
  return String(pick.id)
}

async function toSettings(setting: Db | null): Promise<AppSettings> {
  const { data, error } = await supabase.from('Currency').select('*')
  raise(error)
  const currencyId = setting?.currencyId ? String(setting.currencyId) : await defaultCurrencyId()
  const currency = (data ?? []).find((row) => String(row.id) === currencyId)
  return {
    appName: text(setting?.appName) || 'Excelorithm',
    tagline: text(setting?.tagline) || 'Vending Machine',
    logoUrl: text(setting?.logoUrl),
    currency: currency ? String(currency.code) : 'PKR',
    currencyId,
    currencyName: currency ? String(currency.name) : '',
    currencySymbol: currency ? String(currency.symbol) : '',
    smtp: {
      host: text(setting?.smtpHost),
      port: num(setting?.smtpPort) || 587,
      secure: Boolean(setting?.smtpSecure),
      user: text(setting?.smtpUser),
      pass: text(setting?.smtpPass),
      hasPass: Boolean(text(setting?.smtpPass)),
      from: text(setting?.smtpFrom) || 'Excelorithm Vending <noreply@excelorithm.com>',
    },
    notificationSoundEnabled: setting ? setting.notificationSoundEnabled !== false : true,
    notificationSoundUrl: text(setting?.notificationSoundUrl),
    paymentSoundUrl: text(setting?.paymentSoundUrl),
    unselectSoundUrl: text(setting?.unselectedSoundUrl),
  }
}

async function saveSetting(patch: Db) {
  const existing = await loadSetting()
  const now = nowIso()
  if (!existing) {
    const currencyId = patch.currencyId ?? (await defaultCurrencyId())
    const inserted = await supabase
      .from('Setting')
      .insert({
        appName: 'Excelorithm',
        tagline: 'Vending Machine',
        logoUrl: '',
        smtpHost: '',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: '',
        smtpPass: '',
        smtpFrom: 'Excelorithm Vending <noreply@excelorithm.com>',
        notificationSoundEnabled: true,
        notificationSoundUrl: '',
        paymentSoundUrl: '',
        unselectedSoundUrl: '',
        ...patch,
        currencyId,
        createdAt: now,
        updatedAt: now,
      })
      .select('*')
      .single()
    raise(inserted.error)
    return inserted.data as Db
  }
  const updated = await supabase
    .from('Setting')
    .update({ ...patch, updatedAt: now })
    .eq('id', existing.id)
    .select('*')
    .single()
  raise(updated.error)
  return updated.data as Db
}

async function currenciesById() {
  const { data, error } = await supabase.from('Currency').select('id,code,symbol,name,isActive')
  raise(error)
  return new Map((data ?? []).map((row) => [String(row.id), row]))
}

function mapItem(row: Db, currency?: { code: string; symbol: string }): Item {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    description: '',
    price: num(row.price),
    buyingPrice: num(row.buyingPrice),
    quantity: num(row.quantity),
    imageUrl: String(row.imageUrl ?? ''),
    isActive: row.isActive !== false,
    currencyCode: currency?.code,
    currencySymbol: currency?.symbol,
    createdAt: String(row.createdAt ?? ''),
    updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
  }
}

async function accountFor(userId: string): Promise<Db | null> {
  const { data, error } = await supabase.from('PayableAccount').select('*').eq('userId', userId).limit(1)
  raise(error)
  const row = (data?.[0] as Db | undefined) ?? null
  if (!row || row.deletedAt) return null
  return row
}

async function ensureAccount(userId: string, currencyId: string): Promise<Db> {
  const { data, error } = await supabase.from('PayableAccount').select('*').eq('userId', userId).limit(1)
  raise(error)
  const row = (data?.[0] as Db | undefined) ?? null
  if (row && !row.deletedAt) return row
  if (row) {
    const updated = await supabase
      .from('PayableAccount')
      .update({ deletedAt: null, deletedByUserId: null, deleteByName: '' })
      .eq('id', row.id)
      .select('*')
      .single()
    raise(updated.error)
    return updated.data as Db
  }
  const created = await supabase
    .from('PayableAccount')
    .insert({
      userId,
      currencyId,
      balance: 0,
      totalCharged: 0,
      totalPaid: 0,
      deleteByName: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .select('*')
    .single()
  raise(created.error)
  return created.data as Db
}

function missingRpc(error: { code?: string; message: string }) {
  return error.code === 'PGRST202' || /could not find the function/i.test(error.message)
}

/** Drop one unit. A normal update is ignored when Items blocks the signed-in user, so the database function is the write that sticks. */
async function takeOne(itemId: string, currentQty: number): Promise<number> {
  const rpc = await supabase.rpc('take_item_unit', { item_id: itemId })
  if (!rpc.error && rpc.data != null) return num(rpc.data)
  if (rpc.error && !missingRpc(rpc.error)) throw new Error(rpc.error.message)
  const updated = await supabase
    .from('Items')
    .update({ quantity: currentQty - 1 })
    .eq('id', itemId)
    .eq('quantity', currentQty)
    .select('quantity')
    .maybeSingle()
  if (updated.error && updated.error.code !== 'PGRST116') throw new Error(updated.error.message)
  if (updated.data) return num(updated.data.quantity)
  throw new Error('Could not update stock')
}

async function returnOne(itemId: string): Promise<number | null> {
  const rpc = await supabase.rpc('return_item_unit', { item_id: itemId })
  if (!rpc.error && rpc.data != null) return num(rpc.data)
  if (rpc.error && !missingRpc(rpc.error)) throw new Error(rpc.error.message)
  const current = await supabase.from('Items').select('quantity').eq('id', itemId).maybeSingle()
  if (current.error || !current.data) return null
  const nextQty = num(current.data.quantity) + 1
  const updated = await supabase
    .from('Items')
    .update({ quantity: nextQty })
    .eq('id', itemId)
    .select('quantity')
    .maybeSingle()
  if (updated.error && updated.error.code !== 'PGRST116') throw new Error(updated.error.message)
  return updated.data ? num(updated.data.quantity) : null
}

function mapPending(row: Db): PendingPayment {
  return {
    id: String(row.id),
    amount: round2(num(row.amount)),
    paymentMethod: String(row.paymentMethod ?? ''),
    receiptUrl: text(row.receiptUrl) || null,
    status: String(row.status ?? 'pending') as PaymentStatus,
    note: String(row.note ?? ''),
    createdAt: String(row.createdAt ?? ''),
  }
}

async function pendingFor(userId: string) {
  const { data, error } = await supabase
    .from('Payment')
    .select('*')
    .eq('userId', userId)
    .eq('status', 'pending')
    .order('createdAt', { ascending: true })
  raise(error)
  return (data ?? []) as Db[]
}

function payableState(account: Db | null, pending: Db[]) {
  const amount = round2(num(account?.balance))
  const pendingTotal = round2(pending.reduce((sum, row) => sum + num(row.amount), 0))
  const payments = pending.map(mapPending)
  return {
    amount,
    totalCharged: round2(num(account?.totalCharged)),
    totalPaid: round2(num(account?.totalPaid)),
    pendingTotal,
    payableDueNow: Math.max(0, round2(amount - pendingTotal)),
    pendingPayments: payments,
    pendingPayment: payments[0] ?? null,
  }
}

async function notify(userId: string, type: string, title: string, message: string) {
  const { error } = await supabase.from('Notifications').insert({
    userId,
    type,
    title,
    message,
    isRead: false,
  })
  raise(error)
}

async function managedUser(id: string): Promise<ManagedUser> {
  const user = await supabase.from('Users').select('*').eq('id', id).maybeSingle()
  raise(user.error)
  if (!user.data) throw new Error('User not found')
  const role = await supabase.from('Roles').select('id,code,name').eq('id', user.data.roleId).maybeSingle()
  raise(role.error)
  return {
    id,
    name: personName(text(user.data.firstname), text(user.data.lastname), String(user.data.email)),
    email: String(user.data.email),
    isActive: user.data.isActive !== false,
    roleId: String(user.data.roleId),
    roleCode: roleCode(String(role.data?.code ?? '')),
    roleName: String(role.data?.name ?? ''),
    createdAt: String(user.data.createdAt ?? ''),
    updatedAt: String(user.data.createdAt ?? ''),
  }
}

async function writeProfile(id: string, name: string, email: string, roleId: string, isActive: boolean) {
  const { first, last } = splitName(name)
  const updated = await supabase
    .from('Users')
    .update({ firstname: first, lastname: last, email, roleId, isActive })
    .eq('id', id)
    .select('id')
  raise(updated.error)
  if (updated.data?.length) return
  const inserted = await supabase.from('Users').insert({
    id,
    firstname: first,
    lastname: last,
    email,
    roleId,
    themePreference: 'system',
    avatarUrl: '',
    isActive,
    createdAt: nowIso(),
  })
  raise(inserted.error)
}

/** Insert as the signed-in admin. Update only if a signup trigger already created the row. */
async function insertProfile(id: string, name: string, email: string, roleId: string, isActive: boolean) {
  const { first, last } = splitName(name)
  const inserted = await supabase.from('Users').insert({
    id,
    firstname: first,
    lastname: last,
    email,
    roleId,
    themePreference: 'system',
    avatarUrl: '',
    isActive,
    createdAt: nowIso(),
  })
  if (!inserted.error) return
  const duplicate = inserted.error.code === '23505' || /duplicate key/i.test(inserted.error.message)
  if (!duplicate) throw new Error(inserted.error.message)
  const updated = await supabase
    .from('Users')
    .update({ firstname: first, lastname: last, email, roleId, isActive })
    .eq('id', id)
  raise(updated.error)
}

export const api = {
  async me() {
    return { user: await loadUser(await requireUserId()) }
  },

  async login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (error) throw new Error(error.message)
    if (data.session?.access_token) rememberSession(data.session.access_token)
    return { user: await loadUser(data.user.id) }
  },

  async signup(name: string, email: string, password: string) {
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
    if (error) throw new Error(error.message)
    if (!data.user || !data.session) throw new Error('Check your email to confirm the account')
    rememberSession(data.session.access_token)
    const roles = await supabase.from('Roles').select('id,code')
    raise(roles.error)
    const userRole = (roles.data ?? []).find((row) => String(row.code).toLowerCase() === 'user')
    if (!userRole) throw new Error('User role missing')
    await writeProfile(data.user.id, name, data.user.email ?? email.trim(), String(userRole.id), true)
    return { user: await loadUser(data.user.id) }
  },

  async logout() {
    rememberSession(null)
    const { error } = await supabase.auth.signOut()
    if (error) throw new Error(error.message)
    return { ok: true as const }
  },

  async setTheme(theme: ThemePreference) {
    const id = await requireUserId()
    const { error } = await supabase.from('Users').update({ themePreference: theme }).eq('id', id)
    raise(error)
    return { user: await loadUser(id) }
  },

  async changePassword(currentPassword: string, newPassword: string) {
    const next = await supabase.auth.updateUser({
      password: newPassword,
      current_password: currentPassword,
    })
    if (next.error) {
      const code = (next.error as { code?: string }).code
      if (code === 'current_password_mismatch' || code === 'current_password_required') {
        throw new Error('Current password is wrong')
      }
      throw new Error(next.error.message)
    }
    return { ok: true as const }
  },

  async updateProfile(form: FormData) {
    const id = await requireUserId()
    const current = await loadUser(id)
    const first = formText(form, 'firstName').trim()
    const last = formText(form, 'lastName').trim()
    const avatar = formFile(form, 'avatar')
    const patch: Db = {
      firstname: first,
      lastname: last,
    }
    if (avatar) patch.avatarUrl = await uploadFile(PROFILE_IMAGES_BUCKET, avatar, id)
    const { error } = await supabase.from('Users').update(patch).eq('id', id)
    raise(error)
    const user = await loadUser(id)
    if (!user.name) user.name = current.name
    return { user }
  },

  async publicBranding() {
    return { branding: await loadBranding() }
  },

  async publicSounds() {
    return loadSounds()
  },

  async items() {
    const [items, currencies] = await Promise.all([
      supabase.from('Items').select('*').eq('isActive', true).order('title'),
      currenciesById(),
    ])
    raise(items.error)
    return {
      items: ((items.data ?? []) as Db[]).map((row) => {
        const currency = currencies.get(String(row.currencyId))
        return mapItem(row, currency ? { code: String(currency.code), symbol: String(currency.symbol) } : undefined)
      }),
    }
  },

  async addItem(form: FormData) {
    const userId = await requireUserId()
    const image = formFile(form, 'image')
    if (!image) throw new Error('Image is required')
    const settings = await toSettings(await loadSetting())
    const { data, error } = await supabase
      .from('Items')
      .insert({
        title: formText(form, 'title').trim(),
        price: num(formText(form, 'price')),
        buyingPrice: num(formText(form, 'buyingPrice')),
        quantity: Math.trunc(num(formText(form, 'quantity'))),
        imageUrl: await uploadFile(ITEM_IMAGES_BUCKET, image),
        currencyId: settings.currencyId,
        isActive: true,
        createdByUserId: userId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .select('*')
      .single()
    raise(error)
    return { item: mapItem(data as Db, { code: settings.currency, symbol: settings.currencySymbol }) }
  },

  async updateItem(id: string, form: FormData) {
    const settings = await toSettings(await loadSetting())
    const image = formFile(form, 'image')
    const patch: Db = {
      title: formText(form, 'title').trim(),
      price: num(formText(form, 'price')),
      buyingPrice: num(formText(form, 'buyingPrice')),
      quantity: Math.trunc(num(formText(form, 'quantity'))),
      currencyId: settings.currencyId,
      updatedAt: nowIso(),
    }
    if (image) patch.imageUrl = await uploadFile(ITEM_IMAGES_BUCKET, image)
    const { data, error } = await supabase.from('Items').update(patch).eq('id', id).select('*').single()
    raise(error)
    return { item: mapItem(data as Db, { code: settings.currency, symbol: settings.currencySymbol }) }
  },

  async deleteItem(id: string) {
    const { error } = await supabase.from('Items').update({ isActive: false }).eq('id', id)
    raise(error)
    return { ok: true as const }
  },

  async openCharges() {
    const userId = await requireUserId()
    const account = await accountFor(userId)
    const balance = round2(num(account?.balance))
    if (balance <= 0) return { charges: [] }
    const { data, error } = await supabase
      .from('ItemCharge')
      .select('id,itemId,amount,itemTitle,createdAt')
      .eq('userId', userId)
      .is('deletedAt', null)
      .order('createdAt', { ascending: false })
      .limit(500)
    raise(error)
    const open: Db[] = []
    let remaining = balance
    for (const charge of (data ?? []) as Db[]) {
      if (remaining <= 0) break
      open.push(charge)
      remaining = round2(remaining - num(charge.amount))
    }
    open.reverse()
    return {
      charges: open.map((charge) => ({
        id: String(charge.id),
        itemId: String(charge.itemId),
        amount: round2(num(charge.amount)),
        itemTitle: String(charge.itemTitle),
        createdAt: String(charge.createdAt),
      })),
    }
  },

  // ponytail: stock and the charge are separate writes. Two overlapping clicks can still oversell. Upgrade path: one Postgres function that does both.
  async chargeItem(id: string) {
    const userId = await requireUserId()
    const itemQuery = await supabase.from('Items').select('*').eq('id', id).eq('isActive', true).maybeSingle()
    raise(itemQuery.error)
    const item = itemQuery.data as Db | null
    if (!item) throw new Error('Item not found')
    if (num(item.quantity) <= 0) throw new Error('Item is out of stock')
    const settings = await toSettings(await loadSetting())
    const account = await ensureAccount(userId, settings.currencyId)
    const amount = num(item.price)
    const nextQty = await takeOne(String(item.id), num(item.quantity))
    const charge = await supabase
      .from('ItemCharge')
      .insert({
        payableAccountId: account.id,
        userId,
        itemId: item.id,
        itemTitle: item.title,
        amount,
        costAmount: num(item.buyingPrice),
        currencyId: settings.currencyId,
        deletedByName: '',
        createdAt: nowIso(),
      })
      .select('id')
      .single()
    if (charge.error || !charge.data) {
      await returnOne(String(item.id)).catch(() => undefined)
      throw new Error(charge.error?.message ?? 'Charge failed')
    }
    const chargeRow = charge.data
    const payable = await supabase
      .from('PayableAccount')
      .update({
        balance: round2(num(account.balance) + amount),
        totalCharged: round2(num(account.totalCharged) + amount),
        currencyId: settings.currencyId,
      })
      .eq('id', account.id)
      .select('userId,balance,totalCharged,totalPaid')
      .single()
    raise(payable.error)
    const row = payable.data as Db
    return {
      payable: {
        userId: String(row.userId),
        amount: round2(num(row.balance)),
        totalCharged: round2(num(row.totalCharged)),
        totalPaid: round2(num(row.totalPaid)),
      },
      chargeId: String(chargeRow.id),
      item: mapItem({ ...item, quantity: nextQty }, { code: settings.currency, symbol: settings.currencySymbol }),
    }
  },

  async undoCharge(chargeId: string) {
    const user = await loadUser(await requireUserId())
    const chargeQuery = await supabase
      .from('ItemCharge')
      .select('*')
      .eq('id', chargeId)
      .eq('userId', user.id)
      .is('deletedAt', null)
      .maybeSingle()
    raise(chargeQuery.error)
    const charge = chargeQuery.data as Db | null
    if (!charge) throw new Error('Charge not found')
    const pending = await pendingFor(user.id)
    const pendingTotal = round2(pending.reduce((sum, row) => sum + num(row.amount), 0))
    if (pendingTotal > 0) {
      const open = await supabase
        .from('ItemCharge')
        .select('id,amount')
        .eq('userId', user.id)
        .is('deletedAt', null)
        .order('createdAt', { ascending: true })
        .limit(500)
      raise(open.error)
      let remaining = pendingTotal
      const locked = new Set<string>()
      for (const row of (open.data ?? []) as Db[]) {
        if (remaining <= 0) break
        locked.add(String(row.id))
        remaining = round2(remaining - num(row.amount))
      }
      if (locked.has(String(charge.id))) {
        throw new Error(
          'This item is covered by a pending payment request and cannot be unselected until admin accepts or rejects it.',
        )
      }
    }
    const account = await accountFor(user.id)
    if (!account) throw new Error('Payable account not found')
    const settings = await toSettings(await loadSetting())
    const removed = await supabase
      .from('ItemCharge')
      .update({
        deletedAt: new Date().toISOString(),
        deletedByUserId: user.id,
        deletedByName: user.name,
      })
      .eq('id', charge.id)
    raise(removed.error)
    const item = await supabase.from('Items').select('*').eq('id', charge.itemId).maybeSingle()
    raise(item.error)
    let restored: Db = { id: charge.itemId, quantity: 0 }
    if (item.data) {
      const nextQty = await returnOne(String(charge.itemId))
      restored = { ...(item.data as Db), quantity: nextQty ?? num(item.data.quantity) + 1 }
    }
    const balance = Math.max(0, round2(num(account.balance) - num(charge.amount)))
    const totalCharged = Math.max(0, round2(num(account.totalCharged) - num(charge.amount)))
    const payable = await supabase
      .from('PayableAccount')
      .update({ balance, totalCharged, currencyId: settings.currencyId })
      .eq('id', account.id)
      .select('userId,balance,totalCharged,totalPaid')
      .single()
    raise(payable.error)
    const row = payable.data as Db
    return {
      payable: {
        userId: String(row.userId),
        amount: round2(num(row.balance)),
        totalCharged: round2(num(row.totalCharged)),
        totalPaid: round2(num(row.totalPaid)),
      },
      item: mapItem(restored, {
        code: settings.currency,
        symbol: settings.currencySymbol,
      }),
      itemTitle: String(charge.itemTitle),
    }
  },

  async myPayable() {
    const userId = await requireUserId()
    return payableState(await accountFor(userId), await pendingFor(userId))
  },

  async payables() {
    const [users, roles, accounts, payments, currencies] = await Promise.all([
      supabase.from('Users').select('id,firstname,lastname,email,roleId,isActive'),
      supabase.from('Roles').select('id,code'),
      supabase.from('PayableAccount').select('*').is('deletedAt', null),
      supabase.from('Payment').select('*').order('createdAt', { ascending: false }),
      currenciesById(),
    ])
    raise(users.error)
    raise(roles.error)
    raise(accounts.error)
    raise(payments.error)
    const userRoleIds = new Set(
      (roles.data ?? [])
        .filter((role) => String(role.code).toLowerCase() === 'user')
        .map((role) => String(role.id)),
    )
    const accountByUser = new Map(
      ((accounts.data ?? []) as Db[]).map((account) => [String(account.userId), account]),
    )
    const paymentsByAccount = new Map<string, Db[]>()
    for (const payment of (payments.data ?? []) as Db[]) {
      const key = String(payment.payableAccountId)
      const list = paymentsByAccount.get(key) ?? []
      if (list.length < 20) list.push(payment)
      paymentsByAccount.set(key, list)
    }
    const payables: PayableRow[] = await Promise.all(
      ((users.data ?? []) as Db[])
      .filter((user) => user.isActive !== false && userRoleIds.has(String(user.roleId)))
      .map(async (user) => {
        const account = accountByUser.get(String(user.id)) ?? null
        const list = account ? (paymentsByAccount.get(String(account.id)) ?? []) : []
        const pendingList = list.filter((payment) => payment.status === 'pending')
        const pending = pendingList[0] ?? null
        const latest = list[0] ?? null
        const currency = account ? currencies.get(String(account.currencyId)) : undefined
        return {
          userId: String(user.id),
          name: personName(text(user.firstname), text(user.lastname), String(user.email)),
          email: String(user.email),
          amount: round2(num(account?.balance)),
          totalCharged: round2(num(account?.totalCharged)),
          totalPaid: round2(num(account?.totalPaid)),
          currencyCode: currency ? String(currency.code) : null,
          updatedAt: account?.updatedAt ? String(account.updatedAt) : null,
          paymentMethod: String(pending?.paymentMethod || latest?.paymentMethod || '') || null,
          receiptUrl: text(pending?.receiptUrl || latest?.receiptUrl) || null,
          paymentStatus: (pending?.status || latest?.status || null) as PaymentStatus | null,
          pendingPayments: pendingList.map(mapPending),
          pendingPayment: pending ? mapPending(pending) : null,
        }
      }),
    )
    payables.sort((a, b) => a.name.localeCompare(b.name))
    return { payables }
  },

  async pay(userId: string, amount: number, note: string) {
    return applyPaid(await requireUserId(), userId, amount, note || 'Payment', note.trim() || 'Admin payment')
  },

  async markPaid(userId: string) {
    const account = await accountFor(userId)
    const balance = round2(num(account?.balance))
    if (balance <= 0) {
      return {
        amount: 0,
        totalCharged: round2(num(account?.totalCharged)),
        totalPaid: round2(num(account?.totalPaid)),
      }
    }
    return applyPaid(await requireUserId(), userId, balance, 'Marked paid', 'Admin settlement')
  },

  async softDeletePayable(userId: string) {
    const me = await loadUser(await requireUserId())
    const account = await accountFor(userId)
    if (!account) throw new Error('Payable entry not found')
    const now = new Date().toISOString()
    const updated = await supabase
      .from('PayableAccount')
      .update({ deletedAt: now, deletedByUserId: me.id, deleteByName: me.name })
      .eq('id', account.id)
    raise(updated.error)
    const charges = await supabase
      .from('ItemCharge')
      .update({ deletedAt: now, deletedByUserId: me.id, deletedByName: me.name })
      .eq('payableAccountId', account.id)
      .is('deletedAt', null)
    raise(charges.error)
    return { ok: true as const }
  },

  async acceptPayment(paymentId: string, _status: 'paid' = 'paid') {
    const me = await loadUser(await requireUserId())
    const paymentQuery = await supabase.from('Payment').select('*').eq('id', paymentId).maybeSingle()
    raise(paymentQuery.error)
    const payment = paymentQuery.data as Db | null
    if (!payment || payment.status !== 'pending') throw new Error('Pending payment not found')
    const account = await accountFor(String(payment.userId))
    if (!account || String(account.id) !== String(payment.payableAccountId)) {
      throw new Error('Payable account not found')
    }
    const balanceBefore = round2(num(account.balance))
    const applied = Math.min(round2(num(payment.amount)), balanceBefore)
    const balanceAfter = Math.max(0, round2(balanceBefore - applied))
    const saved = await supabase
      .from('Payment')
      .update({
        status: 'paid',
        amount: applied,
        balanceBefore,
        balanceAfter,
        isFullSettlement: balanceAfter === 0 && balanceBefore > 0,
        recordedByUserId: me.id,
        reviewedAt: new Date().toISOString(),
        rejectionReason: '',
      })
      .eq('id', payment.id)
    raise(saved.error)
    const totalPaid = round2(num(account.totalPaid) + applied)
    const updated = await supabase
      .from('PayableAccount')
      .update({ balance: balanceAfter, totalPaid })
      .eq('id', account.id)
    raise(updated.error)
    const settings = await toSettings(await loadSetting())
    await notify(
      String(payment.userId),
      'payment_accepted',
      'Payment accepted',
      `Your payment of ${settings.currencySymbol}${applied.toFixed(2)} was accepted.`,
    ).catch(() => undefined)
    return { amount: balanceAfter, totalCharged: round2(num(account.totalCharged)), totalPaid }
  },

  async rejectPayment(paymentId: string, reason: string, _status: 'rejected' = 'rejected') {
    const me = await loadUser(await requireUserId())
    const trimmed = reason.trim()
    if (!trimmed) throw new Error('Rejection reason is required')
    const paymentQuery = await supabase.from('Payment').select('*').eq('id', paymentId).maybeSingle()
    raise(paymentQuery.error)
    const payment = paymentQuery.data as Db | null
    if (!payment || payment.status !== 'pending') throw new Error('Pending payment not found')
    const saved = await supabase
      .from('Payment')
      .update({
        status: 'rejected',
        rejectionReason: trimmed,
        recordedByUserId: me.id,
        reviewedAt: new Date().toISOString(),
      })
      .eq('id', payment.id)
    raise(saved.error)
    const account = await accountFor(String(payment.userId))
    const settings = await toSettings(await loadSetting())
    await notify(
      String(payment.userId),
      'payment_rejected',
      'Payment request rejected',
      `Your payment request of ${settings.currencySymbol}${num(payment.amount).toFixed(2)} was rejected. Reason: ${trimmed}. Your payable balance is unchanged.`,
    ).catch(() => undefined)
    return {
      amount: round2(num(account?.balance)),
      totalCharged: round2(num(account?.totalCharged)),
      totalPaid: round2(num(account?.totalPaid)),
    }
  },

  async selfPay(amount: number, method: string, receipt: File) {
    const user = await loadUser(await requireUserId())
    const requested = round2(amount)
    if (!Number.isFinite(requested) || requested <= 0 || !method.trim()) {
      throw new Error('Invalid payment amount or method')
    }
    const account = await accountFor(user.id)
    const balance = round2(num(account?.balance))
    if (!account || balance <= 0) throw new Error('Nothing to pay')
    const pending = await pendingFor(user.id)
    const pendingTotal = round2(pending.reduce((sum, row) => sum + num(row.amount), 0))
    const dueNow = Math.max(0, round2(balance - pendingTotal))
    if (dueNow <= 0) {
      throw new Error(
        'Your outstanding balance is already covered by pending payment requests. Wait for admin review, or add more items first.',
      )
    }
    const applied = Math.min(requested, dueNow)
    const settings = await toSettings(await loadSetting())
    const receiptUrl = await uploadFile(ATTACHMENTS_BUCKET, receipt, user.id)
    const payment = await supabase
      .from('Payment')
      .insert({
        payableAccountId: account.id,
        userId: user.id,
        recordedByUserId: user.id,
        amount: applied,
        balanceBefore: balance,
        balanceAfter: Math.max(0, round2(balance - pendingTotal - applied)),
        note: `Paid via ${method.trim()}`,
        paymentMethod: method.trim(),
        receiptUrl,
        currencyID: settings.currencyId,
        isFullSettlement: round2(pendingTotal + applied) >= balance,
        status: 'pending',
        rejectionReason: '',
        createdAt: nowIso(),
      })
      .select('*')
      .single()
    raise(payment.error)
    const admins = await supabase.from('Roles').select('id').ilike('code', 'admin')
    raise(admins.error)
    const adminIds = (admins.data ?? []).map((role) => String(role.id))
    if (adminIds.length) {
      const adminUsers = await supabase.from('Users').select('id').in('roleId', adminIds).eq('isActive', true)
      raise(adminUsers.error)
      await Promise.all(
        (adminUsers.data ?? []).map((admin) =>
          notify(
            String(admin.id),
            'payment_pending',
            'Payment to review',
            `${user.name} submitted ${settings.currencySymbol}${applied.toFixed(2)} via ${method.trim()}.`,
          ).catch(() => undefined),
        ),
      )
    }
    return payableState(account, [...pending, payment.data as Db])
  },

  async notifications() {
    const userId = await requireUserId()
    const { data, error } = await supabase
      .from('Notifications')
      .select('id,type,title,message,isRead,created_at')
      .eq('userId', userId)
      .order('created_at', { ascending: false })
    raise(error)
    const notifications: AppNotification[] = ((data ?? []) as Db[]).map((row) => ({
      id: String(row.id),
      type: String(row.type),
      title: String(row.title),
      message: String(row.message),
      isRead: Boolean(row.isRead),
      createdAt: String(row.created_at ?? ''),
    }))
    return { notifications }
  },

  async unreadNotifications() {
    const userId = await requireUserId()
    const { count, error } = await supabase
      .from('Notifications')
      .select('id', { count: 'exact', head: true })
      .eq('userId', userId)
      .eq('isRead', false)
    raise(error)
    return { unreadCount: count ?? 0 }
  },

  async markNotificationRead(id: string) {
    const { error } = await supabase.from('Notifications').update({ isRead: true }).eq('id', id)
    raise(error)
    return { ok: true as const }
  },

  async markAllNotificationsRead() {
    const userId = await requireUserId()
    const { error } = await supabase
      .from('Notifications')
      .update({ isRead: true })
      .eq('userId', userId)
      .eq('isRead', false)
    raise(error)
    return { ok: true as const }
  },

  async settings() {
    return { settings: await toSettings(await loadSetting()) }
  },

  async currencies() {
    const { data, error } = await supabase.from('Currency').select('*').eq('isActive', true).order('code')
    raise(error)
    const currencies: CurrencyOption[] = ((data ?? []) as Db[]).map((row) => ({
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      symbol: String(row.symbol),
    }))
    return { currencies }
  },

  async setCurrency(currency: string) {
    const { data, error } = await supabase.from('Currency').select('id').eq('code', currency).maybeSingle()
    raise(error)
    if (!data) throw new Error('Currency not found')
    const saved = await saveSetting({ currencyId: data.id })
    return { settings: await toSettings(saved) }
  },

  async setSmtp(body: { host: string; port: number; secure: boolean; user: string; pass?: string; from: string }) {
    const patch: Db = {
      smtpHost: body.host,
      smtpPort: body.port,
      smtpSecure: body.secure,
      smtpUser: body.user,
      smtpFrom: body.from,
    }
    if (body.pass) patch.smtpPass = body.pass
    const saved = await saveSetting(patch)
    return { settings: await toSettings(saved) }
  },

  async setBranding(form: FormData) {
    const patch: Db = {
      appName: formText(form, 'appName').trim() || 'Excelorithm',
      tagline: formText(form, 'tagline').trim(),
    }
    const logo = formFile(form, 'logo')
    if (logo) patch.logoUrl = await uploadFile(COMPANY_ASSETS_BUCKET, logo, 'logo')
    const saved = await saveSetting(patch)
    return { settings: await toSettings(saved) }
  },

  async setNotifications(form: FormData) {
    const patch: Db = { notificationSoundEnabled: formText(form, 'enabled') !== 'false' }
    const sound = formFile(form, 'sound')
    const payment = formFile(form, 'paymentSound')
    const unselect = formFile(form, 'unselectSound')
    if (sound) patch.notificationSoundUrl = await uploadFile(COMPANY_ASSETS_BUCKET, sound, 'sounds')
    if (payment) patch.paymentSoundUrl = await uploadFile(COMPANY_ASSETS_BUCKET, payment, 'sounds')
    if (unselect) patch.unselectedSoundUrl = await uploadFile(COMPANY_ASSETS_BUCKET, unselect, 'sounds')
    const saved = await saveSetting(patch)
    return { settings: await toSettings(saved) }
  },

  async templates() {
    const { data, error } = await supabase.from('EmailTemplates').select('*').order('name')
    raise(error)
    return { templates: ((data ?? []) as Db[]).map(mapTemplate) }
  },

  async updateTemplate(id: string, body: { name: string; subject: string; body: string }) {
    const { data, error } = await supabase
      .from('EmailTemplates')
      .update({ name: body.name, subject: body.subject, body: body.body, updatedAt: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single()
    raise(error)
    return { template: mapTemplate(data as Db) }
  },

  async createTemplate(body: { code: string; name: string; subject: string; body: string }) {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('EmailTemplates')
      .insert({ code: body.code, name: body.name, subject: body.subject, body: body.body, createdAt: now, updatedAt: now })
      .select('*')
      .single()
    raise(error)
    return { template: mapTemplate(data as Db) }
  },

  async emailUsers() {
    const [users, accounts] = await Promise.all([
      supabase.from('Users').select('id,firstname,lastname,email,isActive'),
      supabase.from('PayableAccount').select('userId,balance').is('deletedAt', null),
    ])
    raise(users.error)
    raise(accounts.error)
    const balance = new Map(((accounts.data ?? []) as Db[]).map((row) => [String(row.userId), num(row.balance)]))
    const list: EmailUser[] = ((users.data ?? []) as Db[])
      .filter((user) => user.isActive !== false)
      .map((user) => ({
        id: String(user.id),
        name: personName(text(user.firstname), text(user.lastname), String(user.email)),
        email: String(user.email),
        payable: round2(balance.get(String(user.id)) ?? 0),
      }))
    return { users: list }
  },

  async emailLogs() {
    const { data, error } = await supabase.from('EmailMessage').select('*').order('createdAt', { ascending: false })
    raise(error)
    return { emails: ((data ?? []) as Db[]).map(mapEmail) }
  },

  async sendEmail(toUserId: string, subject: string, body: string) {
    const me = await loadUser(await requireUserId())
    const to = await loadUser(toUserId)
    const { data, error } = await supabase
      .from('EmailMessage')
      .insert({
        toUserId,
        toEmail: to.email,
        fromEmail: me.email,
        subject,
        body,
        status: 'saved',
        errorMessage: '',
        sentByUserId: me.id,
        sentAt: nowIso(),
        createdAt: nowIso(),
      })
      .select('*')
      .single()
    raise(error)
    return { email: mapEmail(data as Db) }
  },

  async roles() {
    const [roles, users, links, perms] = await Promise.all([
      supabase.from('Roles').select('id,code,name').order('name'),
      supabase.from('Users').select('roleId'),
      supabase.from('RolePermission').select('roleId,PermissionId'),
      supabase.from('Permissions').select('id,code'),
    ])
    raise(roles.error)
    raise(users.error)
    raise(links.error)
    raise(perms.error)
    const codeById = new Map((perms.data ?? []).map((row) => [String(row.id), String(row.code)]))
    const counts = new Map<string, number>()
    for (const user of users.data ?? []) {
      const key = String(user.roleId)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const codesByRole = new Map<string, string[]>()
    for (const link of links.data ?? []) {
      const key = String(link.roleId)
      const code = codeById.get(String(link.PermissionId))
      if (!code) continue
      const list = codesByRole.get(key) ?? []
      list.push(code)
      codesByRole.set(key, list)
    }
    const list: RoleRow[] = (roles.data ?? []).map((role) => {
      const stored = codesByRole.get(String(role.id)) ?? []
      return {
        id: String(role.id),
        code: roleCode(String(role.code)),
        name: String(role.name),
        description: '',
        userCount: counts.get(String(role.id)) ?? 0,
        permissionCodes: stored.length ? stored : fallbackPermissions(String(role.code)),
      }
    })
    return { roles: list }
  },

  async createRole(body: { code: string; name: string; description?: string }) {
    const created = await supabase
      .from('Roles')
      .insert({ code: body.code.trim(), name: body.name.trim() })
      .select('id,code,name')
      .single()
    const data = one(created, 'Role')
    const role: RoleRow = {
      id: String(data.id),
      code: roleCode(String(data.code)),
      name: String(data.name),
      description: body.description ?? '',
      userCount: 0,
      permissionCodes: [],
    }
    return { role }
  },

  async deleteRole(roleId: string) {
    const { error } = await supabase.from('Roles').delete().eq('id', roleId)
    raise(error)
    return { ok: true as const }
  },

  async permissions() {
    const { data, error } = await supabase.from('Permissions').select('id,code,name,module').order('module')
    raise(error)
    const rows = data ?? []
    const permissions: PermissionRow[] = rows.length
      ? rows.map((row) => ({
          id: String(row.id),
          code: String(row.code),
          name: String(row.name),
          description: '',
          module: String(row.module ?? ''),
        }))
      : PERMISSIONS.map((row) => ({
          id: row.code,
          code: row.code,
          name: row.name,
          description: row.description,
          module: row.module,
        }))
    return { permissions }
  },

  async setRolePermissions(roleId: string, permissionCodes: string[]) {
    const ids: string[] = []
    for (const code of permissionCodes) ids.push(await ensurePermissionId(code))
    const removed = await supabase.from('RolePermission').delete().eq('roleId', roleId)
    raise(removed.error)
    if (ids.length) {
      const inserted = await supabase.from('RolePermission').insert(ids.map((PermissionId) => ({ roleId, PermissionId })))
      raise(inserted.error)
    }
    return { role: { id: roleId, permissionCodes } }
  },

  async users() {
    const [users, roles] = await Promise.all([
      supabase.from('Users').select('*').order('firstname'),
      supabase.from('Roles').select('id,code,name'),
    ])
    raise(users.error)
    raise(roles.error)
    const roleById = new Map((roles.data ?? []).map((role) => [String(role.id), role]))
    const list: ManagedUser[] = ((users.data ?? []) as Db[]).map((user) => {
      const role = roleById.get(String(user.roleId))
      return {
        id: String(user.id),
        name: personName(text(user.firstname), text(user.lastname), String(user.email)),
        email: String(user.email),
        isActive: user.isActive !== false,
        roleId: String(user.roleId),
        roleCode: roleCode(String(role?.code ?? '')),
        roleName: String(role?.name ?? ''),
        createdAt: String(user.createdAt ?? ''),
        updatedAt: String(user.createdAt ?? ''),
      }
    })
    return { users: list }
  },

  async userRoles() {
    const { data, error } = await supabase.from('Roles').select('id,code,name').order('name')
    raise(error)
    return {
      roles: (data ?? []).map((role) => ({
        id: String(role.id),
        code: roleCode(String(role.code)),
        name: String(role.name),
      })),
    }
  },

  async createUser(body: { name: string; email: string; password: string; roleId: string; isActive?: boolean }) {
    await requireUserId()
    const { data: adminSession } = await supabase.auth.getSession()
    const adminToken = adminSession.session?.access_token
    if (adminToken) rememberSession(adminToken)
    const client = signupClient()
    const { data, error } = await client.auth.signUp({
      email: body.email.trim(),
      password: body.password,
    })
    if (error) throw new Error(error.message)
    if (!data.user) throw new Error('Could not create the login')
    if (adminToken) rememberSession(adminToken)
    await insertProfile(
      data.user.id,
      body.name,
      data.user.email ?? body.email.trim(),
      body.roleId,
      body.isActive ?? true,
    )
    return { user: await managedUser(data.user.id) }
  },

  async updateUser(
    id: string,
    body: { name?: string; email?: string; password?: string; roleId?: string; isActive?: boolean },
  ) {
    const current = await managedUser(id)
    await writeProfile(
      id,
      body.name ?? current.name,
      (body.email ?? current.email).trim(),
      body.roleId ?? current.roleId,
      body.isActive ?? current.isActive,
    )
    const session = await supabase.auth.getSession()
    const self = session.data.session?.user.id === id
    if (body.password) {
      if (!self) {
        throw new Error('Changing another person’s password needs the Supabase secret key on a server.')
      }
      const { error } = await supabase.auth.updateUser({ password: body.password })
      if (error) throw new Error(error.message)
    }
    if (self && body.email && body.email.trim() !== current.email) {
      const { error } = await supabase.auth.updateUser({ email: body.email.trim() })
      if (error) throw new Error(error.message)
    }
    return { user: await managedUser(id) }
  },

  async deleteUser(id: string) {
    const { error } = await supabase.from('Users').delete().eq('id', id)
    raise(error)
    return { ok: true as const }
  },

  async accountability() {
    const [charges, accounts, items] = await Promise.all([
      supabase.from('ItemCharge').select('itemId,itemTitle,amount,costAmount').is('deletedAt', null),
      supabase.from('PayableAccount').select('balance,totalPaid').is('deletedAt', null),
      supabase.from('Items').select('id,title,quantity,price,buyingPrice').eq('isActive', true).order('title'),
    ])
    raise(charges.error)
    raise(accounts.error)
    raise(items.error)
    const byItem = new Map<string, { title: string; soldQty: number; revenue: number; cost: number }>()
    let totalRevenue = 0
    let totalCost = 0
    let unitsSold = 0
    for (const row of (charges.data ?? []) as Db[]) {
      const revenue = num(row.amount)
      const cost = num(row.costAmount)
      totalRevenue += revenue
      totalCost += cost
      unitsSold += 1
      const key = String(row.itemId)
      const prev = byItem.get(key) ?? { title: String(row.itemTitle), soldQty: 0, revenue: 0, cost: 0 }
      prev.soldQty += 1
      prev.revenue += revenue
      prev.cost += cost
      byItem.set(key, prev)
    }
    const accountRows = (accounts.data ?? []) as Db[]
    const itemRows = (items.data ?? []) as Db[]
    return {
      summary: {
        totalRevenue: round2(totalRevenue),
        totalCost: round2(totalCost),
        grossProfit: round2(totalRevenue - totalCost),
        receivables: round2(accountRows.reduce((sum, row) => sum + num(row.balance), 0)),
        totalCollected: round2(accountRows.reduce((sum, row) => sum + num(row.totalPaid), 0)),
        inventoryCostValue: round2(itemRows.reduce((sum, row) => sum + num(row.quantity) * num(row.buyingPrice), 0)),
        inventorySellValue: round2(itemRows.reduce((sum, row) => sum + num(row.quantity) * num(row.price), 0)),
        unitsSold,
      },
      items: itemRows.map((item) => {
        const sold = byItem.get(String(item.id))
        const soldQty = sold?.soldQty ?? 0
        const revenue = round2(sold?.revenue ?? 0)
        const cost = round2(sold?.cost ?? 0)
        return {
          itemId: String(item.id),
          title: String(item.title),
          quantity: num(item.quantity),
          buyingPrice: num(item.buyingPrice),
          sellingPrice: num(item.price),
          soldQty,
          revenue,
          cost,
          profit: round2(revenue - cost),
          stockCostValue: round2(num(item.quantity) * num(item.buyingPrice)),
          stockSellValue: round2(num(item.quantity) * num(item.price)),
        }
      }),
    }
  },

  async cashlineCompare(form: FormData) {
    const file = formFile(form, 'statement')
    if (!file) throw new Error('Upload a statement file (Excel or CSV)')
    const sheet = await parseStatement(file)
    if (sheet.length === 0) throw new Error('No credit transactions found in the file')
    const payments = await supabase
      .from('Payment')
      .select('id,amount,status,paymentMethod,note,createdAt,reviewedAt,userId')
      .in('status', ['paid', 'pending'])
      .order('createdAt', { ascending: false })
      .limit(5000)
    raise(payments.error)
    const userIds = [...new Set(((payments.data ?? []) as Db[]).map((row) => String(row.userId)))]
    const users = userIds.length
      ? await supabase.from('Users').select('id,firstname,lastname,email').in('id', userIds)
      : { data: [], error: null }
    raise(users.error)
    const byUser = new Map(((users.data ?? []) as Db[]).map((row) => [String(row.id), row]))
    const forMatch = ((payments.data ?? []) as Db[]).map((row) => {
      const person = byUser.get(String(row.userId))
      const date =
        row.status === 'paid' && row.reviewedAt ? new Date(String(row.reviewedAt)) : new Date(String(row.createdAt))
      return {
        id: String(row.id),
        amount: num(row.amount),
        status: String(row.status),
        date,
        userName: person ? personName(text(person.firstname), text(person.lastname), String(person.email)) : '',
        userEmail: person ? String(person.email) : '',
        paymentMethod: String(row.paymentMethod ?? ''),
        note: String(row.note ?? ''),
      }
    })
    const { rows, summary } = matchCashline(sheet, forMatch)
    return {
      rows,
      summary,
      meta: { fileName: file.name, sheetCredits: sheet.length, appPayments: forMatch.length },
    }
  },
}

async function ensurePermissionId(code: string) {
  const found = await supabase.from('Permissions').select('id').eq('code', code).maybeSingle()
  raise(found.error)
  if (found.data?.id) return String(found.data.id)
  const catalog = PERMISSIONS.find((row) => row.code === code)
  const inserted = await supabase
    .from('Permissions')
    .insert({ code, name: catalog?.name ?? code, module: catalog?.module ?? 'General' })
    .select('id')
    .single()
    return String(one(inserted, 'Permission').id)
}

async function applyPaid(actorId: string, userId: string, amount: number, note: string, method: string) {
  const account = await accountFor(userId)
  const balance = round2(num(account?.balance))
  const applied = Math.min(round2(amount), balance)
  if (!account || applied <= 0) throw new Error('Nothing to pay')
  const settings = await toSettings(await loadSetting())
  const balanceAfter = round2(balance - applied)
  const totalPaid = round2(num(account.totalPaid) + applied)
  const payment = await supabase.from('Payment').insert({
    payableAccountId: account.id,
    userId,
    recordedByUserId: actorId,
    amount: applied,
    balanceBefore: balance,
    balanceAfter,
    note,
    paymentMethod: method,
    receiptUrl: '',
    currencyID: settings.currencyId,
    isFullSettlement: balanceAfter === 0,
    status: 'paid',
    rejectionReason: '',
    reviewedAt: nowIso(),
    createdAt: nowIso(),
  })
  raise(payment.error)
  const updated = await supabase.from('PayableAccount').update({ balance: balanceAfter, totalPaid }).eq('id', account.id)
  raise(updated.error)
  await notify(
    userId,
    'payment_recorded',
    'Payment recorded',
    `${settings.currencySymbol}${applied.toFixed(2)} was applied to your payable.`,
  ).catch(() => undefined)
  return {
    amount: balanceAfter,
    totalCharged: round2(num(account.totalCharged)),
    totalPaid,
  }
}

function mapTemplate(row: Db): EmailTemplate {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    subject: String(row.subject),
    body: String(row.body),
    updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
  }
}

function mapEmail(row: Db): EmailLog {
  return {
    id: String(row.id),
    toUserId: String(row.toUserId),
    toEmail: String(row.toEmail),
    fromEmail: String(row.fromEmail ?? ''),
    subject: String(row.subject),
    body: String(row.body),
    status: String(row.status ?? ''),
    sentAt: String(row.sentAt ?? row.createdAt ?? ''),
    createdAt: String(row.createdAt ?? ''),
  }
}
