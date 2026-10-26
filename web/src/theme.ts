import { createTheme } from "@mui/material/styles";

// Colors taken from acura.com: a black header, red call-to-action buttons,
// black and gray text on white and light-gray sections, blue links, and
// square, upper-case buttons. acura.com uses Avenir Next; Nunito Sans is a
// free font with a similar look.
const acura = {
  black: "#000000",
  charcoal: "#2B2E2F",
  red: "#E82C2A",
  redDark: "#C41F1D",
  gray: "#5E6162",
  lightGray: "#CDCDCD",
  background: "#F3F3F3",
  link: "#1881B6",
};

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: acura.red, dark: acura.redDark, contrastText: "#FFFFFF" },
    secondary: { main: acura.charcoal, contrastText: "#FFFFFF" },
    info: { main: acura.link },
    text: { primary: acura.black, secondary: acura.gray },
    background: { default: acura.background, paper: "#FFFFFF" },
    divider: acura.lightGray,
  },
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: '"Nunito Sans", "Avenir Next", "Helvetica Neue", Arial, sans-serif',
    h5: { fontWeight: 700 },
    h6: { fontWeight: 700, letterSpacing: "0.02em" },
    button: { fontWeight: 700, letterSpacing: "0.06em" },
  },
  components: {
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: acura.black,
          color: "#FFFFFF",
          // MUI's disabled color would be invisible on the black bar
          "& .Mui-disabled": { color: "rgba(255, 255, 255, 0.35) !important" },
        },
      },
    },
    MuiButton: {
      // acura.com buttons: square, upper case, no shadow
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { borderRadius: 0, textTransform: "uppercase" } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 600, borderRadius: 4 } },
    },
    MuiLink: {
      styleOverrides: { root: { color: acura.link } },
    },
  },
});
