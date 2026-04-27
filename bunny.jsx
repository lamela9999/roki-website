/* ROKI bunny mascots — uses real NFT artwork.
   Each variant maps to a file in assets/. The NFTs already include
   the square colored background, so we just render the image at the
   requested size and let the source bg show through.
*/

const BUNNY_SRC = {
  hoodie:    'assets/suit.jpg',
  king:      'assets/king.jpg',
  outlaw:    'assets/outlaw.jpg',
  suit:      'assets/hoodie.jpg',
  sage:      'assets/sage.png',
  monk:      'assets/monk.png',
  warrior:   'assets/warrior.png',
  ninja:     'assets/ninja.png',
  visor:     'assets/visor.png',
  detective: 'assets/detective.png',
};

// Native bg color of each NFT image (matches its source square).
const BUNNY_BG = {
  hoodie:    '#25E684',
  king:      '#9A4EDC',
  outlaw:    '#FF5959',
  suit:      '#FFDF3D',
  sage:      '#FF5B94',
  monk:      '#FFDF3D',
  warrior:   '#FF5959',
  ninja:     '#FF5959',
  visor:     '#FFDF3D',
  detective: '#9A4EDC',
};

const Bunny = ({ variant = 'hoodie', size = 300, className = '', style = {}, ...rest }) => {
  const src = BUNNY_SRC[variant] || BUNNY_SRC.hoodie;
  return (
    <img
      src={src}
      alt={variant}
      draggable={false}
      className={`bunny ${className}`}
      style={{
        width: size,
        height: size,
        objectFit: 'cover',
        display: 'block',
        ...style,
      }}
    />
  );
};

window.Bunny = Bunny;
window.BUNNY_BG = BUNNY_BG;
