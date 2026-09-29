// SPDX-License-Identifier: MIT

export const coverageFamilies = ["bcwebmux coverage narrow", "bcwebmux coverage wide"];
let loading;
let ready = false;

export function fontCoverageReady() {
  return ready;
}

export function loadFontCoverage() {
  loading ??= Promise.all(
    ["Narrow", "Wide"].map((width, index) => {
      const url = new URL(`./FontCoverage${width}.ttf`, import.meta.url);
      const face = new FontFace(coverageFamilies[index], `url("${url.href}")`);
      return face.load();
    }),
  )
    .then((faces) => {
      for (const face of faces) document.fonts.add(face);
      ready = true;
    })
    .catch((error) => {
      loading = undefined;
      throw error;
    });
  return loading;
}
