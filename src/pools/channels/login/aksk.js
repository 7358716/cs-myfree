export function startAksk(provider, ch) {
  return { flow: 'aksk', instructions: ['在厂商控制台创建 AK/SK', '分别粘贴 AK 与 SK', '点保存'] }
}
