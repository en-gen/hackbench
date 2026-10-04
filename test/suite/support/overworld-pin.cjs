/**
 * SHA-256s of the Overworld view's vanilla canvases (en-gen/hackbench#363, #364), shared by
 * the Vitest decode tests and the Playwright specs: the hub (half 0, 512x512) and each
 * area's 256x224 window over half 1, per layer set (both layers, L1 (foreground) alone, which
 * is also what a refused L2 leaves, and L2 (background) alone). Hashes, not ROM bytes. They
 * change only when the drawing is meant to change; re-pin after the owner looks.
 */
module.exports = {
  VANILLA_OVERWORLD_HUB_SHA256: {
    BOTH: 'c12aff6573d3180ba664d8fc9e6bcfd8b7e2460f154ff1dce2b50e595be6a480',
    L1: '664576ed357ffba66373b4c2e2bc947cc5b9df6c89c6d58715820f316a811625',
    L2: '6a1171cf22e3d88b36bb86853756a1811783591a65ca3a2f1bbe5f3d75b0fd26',
  },
  VANILLA_OVERWORLD_AREA_SHA256: {
    1: {
      BOTH: '0e492ed1b3b750bff59c83b0a153a74228f7137f8aeb078fd8f767d365b569f9',
      L1: '98acec53b713b73c3115e59918cffe4a7b53f75ce8efed94e29b610e4bdd1192',
      L2: '8db2192ccc61f91934e88bfb61d827ea2027235d0a66b62bbbda700aa3ae3789',
    },
    2: {
      BOTH: 'cbd3e166ec7022269a06d946a9e327c6392da06bba7198b42cf54b2c1952995a',
      L1: '7f9a49d85a5f362926fcefb34e9f7d6cb9c11f336f9dcd4cede993ab47fbf5bc',
      L2: '6ea9aa5d15498e0a9f556941f0d37de0877afc26d841fd71eda6b15a4c7c614e',
    },
    3: {
      BOTH: '25af14beeb5d1d7df1d5a1518ad8c91c875f7c85b5b62598fdb52d8bea79554e',
      L1: '63613a7d0e3472d0bc4a0a838d742e4453ce34cd722b0a731180cdce3d782237',
      L2: 'd267f49699ad09bc857fd129e4b869b9ae2577c3c3e979e85794fa9b85b62ee9',
    },
    4: {
      BOTH: '2c376225784db31bdc486d77bd15aa7ea28fb951d38e97dae5fa99312ce72f65',
      L1: 'db024faf085635e6965277567144275f33a9a94323c0a575a73bb28dbe8e4ab8',
      L2: 'e28c2508087244c9ba23f7cb4154e1eb1376c823ca1a739a7f469cf21f6eb8f7',
    },
    5: {
      BOTH: '8859e46bd33924ec5a2144a13310c65872077d189f17194eb856aab3322806d8',
      L1: 'd1168de5199632c53a3592c1d78887fa1b7294a37055a36111618084a94a2eea',
      L2: '438a5ce14a407b50fd704ffedced253fdc17bf2774e54da5c1ac8fe3a8bc6cca',
    },
    6: {
      BOTH: '50fae08a7773d841751e1aaf645a0e8dc27f0d3a96cb19f980e4b4dc9266c917',
      L1: '3f2551162d2a404091bdaff7b629e0f26e085840705203e99db9585fa8ec5046',
      L2: 'eba0d237da44a650923d89ac229c8f81b0a96a792da6a486a8578753ae4527a9',
    },
  },
}
