/**
 * The SNES controller drawing, as a string so it can be inlined and recolored
 * through CSS custom properties (--hb-pad-*, see style/gamepad.css), the same
 * reason logo.ts is a string.
 *
 * Source: "SNES controller.svg" by DhulKarnain, Open Clip Art Library,
 * https://upload.wikimedia.org/wikipedia/commons/f/f4/SNES_controller.svg,
 * released under CC0 1.0 (public domain dedication). Changed: Inkscape
 * metadata and the label text removed, face-button, face-disc and body
 * colors read from custom properties, and each pressable part tagged data-btn with its libretro joypad id.
 */
export const CONTROLLER_SVG = `<svg viewBox="70 100 860 390" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="linearGradient3566">
      <stop style="stop-color:#f0f0ec;" offset="0" />
      <stop style="stop-color:#babab7;" offset="1" />
    </linearGradient>
    <linearGradient id="linearGradient4966">
      <stop style="stop-color:var(--hb-pad-y-1,#00dea5);" offset="0" />
      <stop style="stop-color:var(--hb-pad-y-2,#00f8b9);" offset="1" />
    </linearGradient>
    <linearGradient id="linearGradient4907">
      <stop offset="0" style="stop-color:#8d8d8c;" />
      <stop style="stop-color:var(--hb-pad-body-a,#f6f6f4);" offset="0.25416961" />
      <stop offset="1" style="stop-color:var(--hb-pad-body-b,#f3f3ef);" />
    </linearGradient>
    <linearGradient id="linearGradient4899">
      <stop offset="0" style="stop-color:#dcdcd9;" />
      <stop style="stop-color:#f0f0ee;" offset="0.65597826" />
      <stop offset="1" style="stop-color:#f3f3ef;" />
    </linearGradient>
    <linearGradient id="linearGradient4887">
      <stop style="stop-color:#5b5b5a;" offset="0" />
      <stop offset="0.31944445" style="stop-color:#5d5d5d;" />
      <stop style="stop-color:#f9f9f9;" offset="1" />
    </linearGradient>
    <linearGradient id="linearGradient4841">
      <stop style="stop-color:#d3d3d3;" offset="0" />
      <stop offset="0.53977019" style="stop-color:#ededed;" />
      <stop style="stop-color:#4d4d4d;" offset="1" />
    </linearGradient>
    <linearGradient id="linearGradient4717">
      <stop style="stop-color:#2a2d2e;" offset="0" />
      <stop offset="0.98000002" style="stop-color:#d7d6d7;" />
      <stop style="stop-color:#000000;" offset="0.99000001" />
      <stop style="stop-color:#859094;" offset="1" />
    </linearGradient>
    <linearGradient id="linearGradient4154">
      <stop style="stop-color:#899194;" offset="0" />
      <stop offset="1" style="stop-color:#5e6667;" />
      <stop style="stop-color:#515759;" offset="1" />
    </linearGradient>
    <linearGradient id="linearGradient4124">
      <stop style="stop-color:#303638;" offset="0" />
      <stop offset="1" style="stop-color:#424a4f;" />
    </linearGradient>
    <linearGradient id="linearGradient4089">
      <stop style="stop-color:#f3f3f1;" offset="0" />
      <stop offset="0.94" style="stop-color:#7f7f7e;" />
      <stop style="stop-color:#e6e6e3;" offset="1" />
    </linearGradient>
    <linearGradient id="linearGradient4025">
      <stop offset="0" style="stop-color:#000000;" />
      <stop style="stop-color:#dcdcdc;" offset="0.3888889" />
      <stop offset="1" style="stop-color:#eeeee9;" />
    </linearGradient>
    <radialGradient href="#linearGradient4025" id="radialGradient4049" cx="170" cy="300" fx="170" fy="300" r="96.805557" gradientUnits="userSpaceOnUse" />
    <radialGradient href="#linearGradient4089" id="radialGradient4107" cx="170" cy="300" fx="170" fy="300" r="97.111115" gradientUnits="userSpaceOnUse" />
    <radialGradient href="#linearGradient4124" id="radialGradient4130" cx="306.00046" cy="299.30283" fx="306.00046" fy="299.30283" r="11.154825" gradientUnits="userSpaceOnUse" />
    <radialGradient href="#linearGradient4124" id="radialGradient4142" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1,0,0,1.0280112,0,-7.1062765)" cx="246.84801" cy="253.6937" fx="246.84801" fy="253.6937" r="16.627798" />
    <radialGradient href="#linearGradient4154" id="radialGradient4174" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1,0,0,0.25778,0,394.0318)" cx="63.996368" cy="530.88275" fx="63.996368" fy="530.88275" r="32.95863" />
    <radialGradient href="#linearGradient4717" id="radialGradient4723" cx="621" cy="301" fx="621" fy="301" r="154.5" gradientUnits="userSpaceOnUse" />
    <linearGradient href="#linearGradient4887" id="linearGradient4893" x1="500" y1="508" x2="512.44775" y2="82" gradientUnits="userSpaceOnUse" />
    <linearGradient href="#linearGradient4907" id="linearGradient4915" x1="500" y1="508" x2="512.44775" y2="82" gradientUnits="userSpaceOnUse" />
    <linearGradient href="#linearGradient4899" id="linearGradient4931" x1="140.66206" y1="143.66698" x2="349.68732" y2="143.66698" gradientUnits="userSpaceOnUse" />
    <radialGradient href="#linearGradient4841" id="radialGradient4948" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1.7645947,-0.297109,7.9491748e-2,0.4721195,-198.87963,148.68252)" cx="245.17468" cy="143.66698" fx="245.17468" fy="143.66698" r="104.51264" />
    <linearGradient href="#linearGradient4899" id="linearGradient4950" gradientUnits="userSpaceOnUse" x1="140.66206" y1="143.66698" x2="349.68732" y2="143.66698" />
    <radialGradient href="#linearGradient4841" id="radialGradient4952" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1.7645947,-0.297109,7.9491748e-2,0.4721195,-198.87963,148.68252)" cx="245.17468" cy="143.66698" fx="245.17468" fy="143.66698" r="104.51264" />
    <linearGradient href="#linearGradient4899" id="linearGradient4954" gradientUnits="userSpaceOnUse" x1="140.66206" y1="143.66698" x2="349.68732" y2="143.66698" />
    <radialGradient href="#linearGradient4841" id="radialGradient4956" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1.7645947,-0.297109,7.9491748e-2,0.4721195,-198.87963,150.80384)" cx="245.17468" cy="143.66698" fx="245.17468" fy="143.66698" r="104.51264" />
    <linearGradient href="#linearGradient4899" id="linearGradient4958" gradientUnits="userSpaceOnUse" gradientTransform="translate(0,2.1213203)" x1="140.66206" y1="143.66698" x2="349.68732" y2="143.66698" />
    <radialGradient href="#linearGradient4841" id="radialGradient4960" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1.7645947,-0.297109,7.9491748e-2,0.4721195,-198.87963,148.68252)" cx="245.17468" cy="143.66698" fx="245.17468" fy="143.66698" r="104.51264" />
    <linearGradient href="#linearGradient4899" id="linearGradient4962" gradientUnits="userSpaceOnUse" x1="140.66206" y1="143.66698" x2="349.68732" y2="143.66698" />
    <radialGradient href="#linearGradient4841" id="radialGradient4964" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1.7645947,-0.297109,7.9491748e-2,0.4721195,-198.87963,148.68252)" cx="245.17468" cy="143.66698" fx="245.17468" fy="143.66698" r="104.51264" />
    <linearGradient href="#linearGradient4966" id="linearGradient4972" x1="542.5" y1="334.09967" x2="542.5" y2="257.43439" gradientUnits="userSpaceOnUse" />
    <linearGradient href="#linearGradient3566" id="linearGradient3572" x1="492.77176" y1="132.51852" x2="492.77176" y2="134.27342" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1,0,0,1.6685383,9.3750002,-85.831423)" />
    <radialGradient href="#linearGradient4154" id="radialGradient3578" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1.7547305,-5.1588377e-3,5.5715772e-4,0.189512,-45.845799,433.35427)" cx="63.996368" cy="530.88281" fx="63.996368" fy="530.88281" r="32.95863" />
  </defs>
  <g style=""
    >
    <g transform="matrix(-1,0,0,1,1000.3494,-4.5732233)" style="fill:url(#radialGradient4964);stroke:url(#linearGradient4931);stroke-width:1">
      <g style="fill:url(#radialGradient4960);stroke:url(#linearGradient4962)">
        <g transform="matrix(-1,0,0,1,1000.3494,2.1213203)" style="fill:url(#radialGradient4952);stroke:url(#linearGradient4954);stroke-width:1" data-btn="10">
          <path d="M 145.19,174.21 C 141.42,173.49 140.93,170.35 141.23,165.35 C 141.64,158.67 142.37,157.39 143.93,155.28 C 146.73,151.51 151.24,147.83 154.10,145.71 C 156.92,143.62 159.83,141.61 162.84,139.67 C 165.86,137.73 168.89,135.91 171.94,134.19 C 175.07,132.42 178.21,130.77 181.39,129.23 C 184.63,127.66 187.90,126.19 191.19,124.85 C 194.53,123.50 197.91,122.25 201.32,121.13 C 204.74,120.01 208.19,119.01 211.69,118.13 C 215.18,117.25 218.74,116.49 222.32,115.84 C 225.85,115.20 229.41,114.66 233.04,114.24 C 236.61,113.83 240.25,113.53 243.92,113.33 C 245.69,113.23 315.53,113.11 339.86,113.11 C 345.95,114.49 352.23,124.25 347.55,130.88 C 321.87,130.88 248.14,131.02 246.27,131.13 C 242.40,131.36 238.56,131.71 234.80,132.18 C 230.96,132.66 227.21,133.28 223.47,134.02 C 219.70,134.77 215.94,135.63 212.26,136.64 C 208.56,137.66 204.92,138.81 201.31,140.09 C 197.71,141.38 194.15,142.81 190.62,144.37 C 187.15,145.90 183.69,147.59 180.27,149.39 C 176.92,151.16 173.60,153.06 170.30,155.09 C 167.08,157.07 163.89,159.16 160.70,161.39 C 154.89,165.71 150.62,169.41 145.19,174.21 z" style="fill:url(#radialGradient4948);fill-rule:evenodd;stroke:url(#linearGradient4950);stroke-width:1" />
        </g>
        <path data-btn="11" style="fill:url(#radialGradient4956);fill-rule:evenodd;stroke:url(#linearGradient4958);stroke-width:1" d="M 145.19,176.34 C 141.42,175.61 140.93,172.48 141.23,167.47 C 141.64,160.80 142.37,159.51 143.93,157.40 C 146.73,153.63 151.24,149.95 154.10,147.83 C 156.92,145.74 159.83,143.73 162.84,141.79 C 165.86,139.85 168.89,138.03 171.94,136.31 C 175.07,134.54 178.21,132.89 181.39,131.35 C 184.63,129.78 187.90,128.31 191.19,126.97 C 194.53,125.62 197.91,124.37 201.32,123.25 C 204.74,122.13 208.19,121.13 211.69,120.25 C 215.18,119.37 218.74,118.61 222.32,117.96 C 225.85,117.32 229.41,116.78 233.04,116.36 C 236.61,115.95 240.25,115.65 243.92,115.45 C 245.69,115.35 315.53,115.23 339.86,115.23 C 345.95,116.61 352.23,126.38 347.55,133.00 C 321.87,133.00 248.14,133.14 246.27,133.25 C 242.40,133.48 238.56,133.83 234.80,134.30 C 230.96,134.79 227.21,135.40 223.47,136.14 C 219.70,136.89 215.94,137.75 212.26,138.77 C 208.56,139.78 204.92,140.93 201.31,142.22 C 197.71,143.50 194.15,144.93 190.62,146.49 C 187.15,148.03 183.69,149.71 180.27,151.52 C 176.92,153.28 173.60,155.18 170.30,157.22 C 167.08,159.19 163.89,161.28 160.70,163.52 C 154.89,167.83 150.62,171.53 145.19,176.34 z"
           />
      </g>
    </g>
    <path d="M 716.44,130.79 C 704.94,130.80 250.01,130.91 246.27,131.13 C 242.40,131.36 238.56,131.71 234.80,132.18 C 230.96,132.66 227.21,133.28 223.47,134.02 C 219.70,134.77 215.94,135.63 212.26,136.64 C 208.56,137.66 204.92,138.81 201.31,140.09 C 197.71,141.38 194.15,142.81 190.62,144.37 C 187.15,145.90 183.69,147.59 180.27,149.39 C 176.92,151.16 173.60,153.06 170.30,155.09 C 167.08,157.07 163.89,159.16 160.70,161.39 C 157.52,163.62 154.45,165.93 151.47,168.33 C 148.45,170.76 145.51,173.27 142.70,175.87 C 139.86,178.50 137.15,181.22 134.52,184.01 C 131.87,186.82 129.31,189.74 126.87,192.71 C 124.42,195.70 122.09,198.73 119.86,201.86 C 117.62,205.01 115.49,208.26 113.49,211.53 C 111.47,214.83 109.56,218.17 107.79,221.58 C 106.00,225.00 104.34,228.48 102.80,232.01 C 101.25,235.54 99.86,239.11 98.56,242.73 C 97.26,246.36 96.05,250.02 95.00,253.72 C 93.95,257.43 93.06,261.16 92.26,264.93 C 91.46,268.70 90.78,272.52 90.24,276.33 C 89.70,280.14 89.28,283.96 89.00,287.81 C 88.72,291.65 88.57,295.50 88.55,299.36 C 88.53,303.20 88.64,307.06 88.89,310.91 C 89.13,314.74 89.50,318.59 90.01,322.42 C 90.52,326.23 91.16,330.00 91.92,333.78 C 92.69,337.55 93.60,341.31 94.62,345.03 C 95.64,348.73 96.79,352.41 98.07,356.06 C 99.35,359.67 100.74,363.26 102.27,366.82 C 103.79,370.34 105.45,373.84 107.22,377.28 C 108.98,380.69 110.84,384.05 112.85,387.37 C 114.83,390.64 116.92,393.87 119.15,397.04 C 121.38,400.22 123.69,403.29 126.09,406.27 C 128.52,409.29 131.02,412.23 133.62,415.04 C 136.25,417.89 138.97,420.59 141.76,423.22 C 144.58,425.87 147.50,428.44 150.46,430.87 C 153.45,433.32 156.48,435.66 159.61,437.88 C 162.76,440.12 166.01,442.25 169.29,444.26 C 172.58,446.27 175.93,448.18 179.34,449.96 C 182.76,451.74 186.24,453.40 189.76,454.94 C 193.30,456.49 196.87,457.88 200.49,459.18 C 204.12,460.48 207.77,461.69 211.47,462.74 C 215.18,463.80 218.92,464.68 222.69,465.48 C 226.46,466.28 230.27,466.97 234.09,467.51 C 237.90,468.05 241.72,468.46 245.56,468.74 C 249.40,469.02 253.26,469.18 257.11,469.19 C 260.96,469.21 264.81,469.10 268.66,468.86 C 272.50,468.61 276.35,468.24 280.17,467.73 C 283.98,467.23 287.75,466.59 291.54,465.82 C 295.30,465.05 299.06,464.15 302.79,463.12 C 306.49,462.10 310.16,460.95 313.81,459.67 C 317.43,458.40 321.02,457.00 324.57,455.47 C 328.09,453.95 331.59,452.29 335.04,450.52 C 338.44,448.77 341.81,446.90 345.12,444.89 C 346.76,443.91 351.63,439.91 354.80,439.46 C 358.01,439.00 638.75,437.62 642.00,438.59 L 645.56,439.65 C 647.55,440.25 651.59,442.95 654.87,444.89 C 658.20,446.87 661.55,448.77 664.95,450.52 C 668.40,452.29 671.90,453.95 675.42,455.47 C 678.97,457.00 682.56,458.40 686.18,459.67 C 689.83,460.95 693.50,462.10 697.20,463.12 C 700.93,464.15 704.65,465.05 708.42,465.82 C 712.20,466.59 716.01,467.23 719.82,467.73 C 723.64,468.24 727.49,468.61 731.33,468.86 C 735.18,469.10 739.03,469.21 742.88,469.19 C 746.73,469.18 750.59,469.02 754.43,468.74 C 758.27,468.46 762.09,468.05 765.90,467.51 C 769.72,466.97 773.50,466.28 777.27,465.48 C 781.03,464.68 784.81,463.80 788.52,462.74 C 792.22,461.69 795.87,460.48 799.50,459.18 C 803.12,457.88 806.69,456.49 810.23,454.94 C 813.75,453.40 817.23,451.74 820.65,449.96 C 824.06,448.18 827.41,446.27 830.70,444.26 C 833.98,442.25 837.19,440.12 840.34,437.88 C 843.47,435.66 846.54,433.32 849.53,430.87 C 852.49,428.44 855.41,425.87 858.23,423.22 C 861.02,420.59 863.70,417.89 866.33,415.04 C 868.93,412.23 871.47,409.29 873.90,406.27 C 876.30,403.29 878.61,400.22 880.84,397.04 C 883.07,393.87 885.16,390.64 887.14,387.37 C 889.15,384.05 891.01,380.69 892.77,377.28 C 894.54,373.84 896.20,370.34 897.72,366.82 C 899.25,363.26 900.64,359.67 901.92,356.06 C 903.20,352.41 904.35,348.73 905.37,345.03 C 906.39,341.31 907.30,337.55 908.07,333.78 C 908.83,330.00 909.47,326.23 909.98,322.42 C 910.49,318.59 910.86,314.74 911.10,310.91 C 911.35,307.06 911.46,303.20 911.44,299.36 C 911.42,295.50 911.27,291.65 910.99,287.81 C 910.71,283.96 910.29,280.14 909.75,276.33 C 909.21,272.52 908.53,268.70 907.73,264.93 C 906.93,261.16 906.00,257.43 904.95,253.72 C 903.90,250.02 902.73,246.36 901.43,242.73 C 900.13,239.11 898.70,235.54 897.15,232.01 C 895.61,228.48 893.95,225.00 892.17,221.58 C 890.39,218.17 888.52,214.83 886.50,211.53 C 884.50,208.26 882.37,205.01 880.13,201.86 C 877.90,198.73 875.57,195.70 873.12,192.71 C 870.68,189.74 868.12,186.82 865.47,184.01 C 862.84,181.22 860.10,178.50 857.25,175.87 C 854.44,173.27 851.54,170.76 848.52,168.33 C 845.54,165.93 842.47,163.62 839.29,161.39 C 836.10,159.16 832.91,157.07 829.69,155.09 C 826.39,153.06 823.03,151.16 819.68,149.39 C 816.26,147.59 812.84,145.90 809.37,144.37 C 805.84,142.81 802.28,141.38 798.68,140.09 C 795.07,138.81 791.39,137.66 787.69,136.64 C 784.01,135.63 780.29,134.77 776.52,134.02 C 772.78,133.28 768.99,132.66 765.15,132.18 C 761.39,131.71 757.59,131.36 753.72,131.13 C 750.35,130.93 716.86,130.79 716.44,130.79 z" style="fill:url(#linearGradient4915);fill-rule:evenodd;stroke:url(#linearGradient4893);stroke-width:5" />
    <path style="fill:url(#radialGradient4049);stroke:url(#radialGradient4107);stroke-width:3.33333325" d="M 266,300 A 96,96 0 1 1 74,300 A 96,96 0 1 1 266,300 z" transform="matrix(1.1486534,0,0,1.1486534,52.05556,-44.596021)" />
    <path style="fill:var(--hb-pad-face,#777f82);stroke:url(#radialGradient4723);stroke-width:5" d="M 773,301 A 152,152 0 1 1 469,301 A 152,152 0 1 1 773,301 z" transform="translate(119.05204,7.3806597e-7)" />
    <rect style="fill:#f4f4f1;stroke:#fdfdfa;stroke-width:0.99999994" id="rect3217" width="159" height="65" x="235.90645" y="652.72327" rx="36" transform="matrix(0.7071068,-0.7071068,0.7071068,0.7071068,0,0)" />
    <use x="0" href="#rect3217" transform="translate(80,75)" width="800" height="600" />
    <path style="fill:#1a1a1a;stroke:#ebebe8;stroke-width:0.95238096" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" transform="matrix(1.05,0,0,1.05,103.92704,-17.899999)" />
    <path transform="matrix(0.95,0,0,0.95,158.17704,11.900001)" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" data-btn="1" style="fill:url(#linearGradient4972);stroke:var(--hb-pad-y-stroke,#00ab7f);stroke-width:2.10526323"
       />
    <path transform="matrix(1.05,0,0,1.05,184.42704,58.100001)" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" style="fill:#1a1a1a;stroke:#ebebe8;stroke-width:0.95238096"
       />
    <path style="fill:var(--hb-pad-b,#ffbb58);stroke:var(--hb-pad-b-stroke,#ba853d);stroke-width:2.10526323" data-btn="0" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" transform="matrix(0.95,0,0,0.95,238.67704,87.900001)" />
    <path style="fill:#1a1a1a;stroke:#ebebe8;stroke-width:0.95238096" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" transform="matrix(1.05,0,0,1.05,251.92704,-9.8999993)" />
    <path transform="matrix(0.95,0,0,0.95,306.17704,19.900001)" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" data-btn="8" style="fill:var(--hb-pad-a,#ff4856);stroke:var(--hb-pad-a-stroke,#c72b3e);stroke-width:2.10526323"
       />
    <path transform="matrix(1.05,0,0,1.05,170.92704,-85.399999)" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" style="fill:#1a1a1a;stroke:#ebebe8;stroke-width:0.95238096"
       />
    <path style="fill:var(--hb-pad-x,#0075fa);stroke:var(--hb-pad-x-stroke,#0054b3);stroke-width:2.10526323" data-btn="9" d="M 570,298 A 27.5,27.5 0 1 1 515,298 A 27.5,27.5 0 1 1 570,298 z" transform="matrix(0.95,0,0,0.95,225.17704,-55.599999)" />
    <g data-btn="2" transform="translate(14,0)">
      <rect transform="matrix(0.7071068,-0.7071068,0.7071068,0.7071068,0,0)" rx="7.3457208" y="523.89368" x="32.659458" height="19.478285" width="68.390419" style="fill:#1a1a1a;stroke:#e2e2df;stroke-width:1.83643019" />
      <rect transform="matrix(0.7071068,-0.7071068,0.7071068,0.7071068,0,0)" style="fill:url(#radialGradient3578);stroke:#252a2a;stroke-width:1.21500003" width="64.702263" height="15.777154" x="34.395237" y="525.7442" rx="5.9500341" />
    </g>
    <path style="fill:#1a1a1a;stroke:#8e979e;stroke-width:0.93806696" d="M 230.57,224.95 C 226.12,224.95 222.53,228.54 222.53,232.99 L 222.53,275.20 L 180.32,275.20 C 175.86,275.20 172.28,278.79 172.28,283.24 L 172.28,316.75 C 172.28,321.20 175.86,324.79 180.32,324.79 L 222.53,324.79 L 222.53,367.00 C 222.53,371.45 226.12,375.04 230.57,375.04 L 264.07,375.04 C 268.53,375.04 272.11,371.45 272.11,367.00 L 272.11,324.79 L 314.33,324.79 C 318.78,324.79 322.37,321.20 322.37,316.75 L 322.37,283.24 C 322.37,278.79 318.78,275.20 314.33,275.20 L 272.11,275.20 L 272.11,232.99 C 272.11,228.54 268.53,224.95 264.07,224.95 L 230.57,224.95 z"
       />
    <path d="M 233.57,231.91 C 230.05,231.91 227.21,235.12 227.21,239.12 L 227.21,279.69 L 185.83,279.69 C 182.30,279.69 179.46,282.90 179.46,286.90 L 179.46,313.06 C 179.46,317.05 182.30,320.26 185.83,320.26 L 227.21,320.26 L 227.21,361.06 C 227.21,365.05 230.05,368.27 233.57,368.27 L 260.43,368.27 C 263.96,368.27 266.80,365.05 266.80,361.06 L 266.80,320.26 L 308.98,320.26 C 312.51,320.26 315.35,317.05 315.35,313.06 L 315.35,286.90 C 315.35,282.90 312.51,279.69 308.98,279.69 L 267.48,279.69 L 267.48,239.12 C 267.48,235.12 264.64,231.91 261.11,231.91 L 233.57,231.91 z" style="fill:#4d5254;stroke:#63686b;stroke-width:1.91442239" />
    <path style="fill:url(#radialGradient4142);stroke:#4f5457;stroke-width:2.06114793;stroke-opacity:0.8627451" d="M 231.71,267.52 C 230.30,264.68 232.56,260.21 232.56,260.21 L 237.28,250.75 L 242.00,241.28 C 242.00,241.28 243.89,237.63 246.72,237.63 C 249.55,237.63 251.44,241.28 251.44,241.28 L 256.16,250.75 L 260.88,260.21 C 260.88,260.21 263.43,264.52 262.01,267.36 C 260.60,270.20 256.16,269.68 256.16,269.68 L 246.72,269.68 L 237.28,269.68 C 237.28,269.68 233.13,270.36 231.71,267.52 z" id="path3924" data-btn="4"
       />
    <use x="0" href="#path3924" id="use3931" data-btn="5" transform="matrix(1,0,0,-1,0,598.76219)"
       />
    <use x="0" href="#path3924" data-btn="6" transform="matrix(0,-1,1,0,-52.533083,546.22911)"
       />
    <use x="0" href="#use3931" data-btn="7" transform="matrix(0,-1,1,0,-52.533083,546.22911)"
       />
    <path style="fill:url(#radialGradient4130);stroke:#4f5457;stroke-width:1.45000005;stroke-opacity:0.86170206" d="M 316.43,299.30 A 10.42,10.42 0 1 1 295.57,299.30 A 10.42,10.42 0 1 1 316.43,299.30 z" transform="matrix(1.6288945,0,0,1.6288945,-251.11585,-187.53276)" />
    <g data-btn="3" transform="translate(112.9467,0)">
      <rect style="fill:#1a1a1a;stroke:#e2e2df;stroke-width:1.83643019" width="68.390419" height="19.478285" x="29.909458" y="521.14368" rx="7.3457208" transform="matrix(0.7071068,-0.7071068,0.7071068,0.7071068,0,0)" />
      <rect rx="5.9500341" y="522.9942" x="31.645237" height="15.777154" width="64.702263" style="fill:url(#radialGradient4174);stroke:#252a2a;stroke-width:1.21500003" transform="matrix(0.7071068,-0.7071068,0.7071068,0.7071068,0,0)" />
    </g>
    <rect style="fill:url(#linearGradient3572);stroke:none;stroke-width:0.5;enable-background:new" width="36.5" height="8.3873806" x="481.75" y="128.3867" rx="0.69999999" ry="1.1679767" />
  </g>
  </svg>`
