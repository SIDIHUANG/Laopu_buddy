/**
 * 气泡皮肤：把通知渲染进用户提供的九宫格气泡素材里。
 *
 * 做法：CSS border-image + fill。
 *   - slice 用源图像素（告诉浏览器怎么切）
 *   - border 用渲染厚度（CSS px，告诉浏览器四角画多大）
 *   - fill 关键字让中心格也绘制，这样气泡有底色，文字直接压在中心区
 * 好处是描边和尾巴不会随文字长度拉伸变形，只有中段被拉伸。
 *
 * 素材缺失或加载失败时不报错，只是不启用皮肤 —— 由 CSS 的 .bubble-skin 类控制，
 * 页面会留在原来的扁平气泡样式上。
 */

export async function applyBubbleSkin(base = 'assets/') {
  try {
    const res = await fetch(`${base}ui/bubble.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    const root = document.documentElement.style;
    const s = meta.slice;
    const b = meta.border;
    root.setProperty('--bub-img', `url("${base}${meta.file}")`);
    root.setProperty('--bub-slice',
      `${s.top} ${s.right} ${s.bottom} ${s.left}`);
    // 渲染厚度收窄一点：左右各 16px 会吃掉 32px 正文宽度，台词就得多折一行
    const shrink = (v, min) => Math.max(min, v - 3);
    root.setProperty('--bub-top', `${b.top}px`);
    root.setProperty('--bub-right', `${shrink(b.right, 10)}px`);
    root.setProperty('--bub-bottom', `${b.bottom}px`);
    root.setProperty('--bub-left', `${shrink(b.left, 10)}px`);
    document.body.classList.add('bubble-skin');
    return meta;
  } catch (e) {
    console.warn('[skin] 气泡皮肤未启用：', e.message);
    return null;
  }
}
