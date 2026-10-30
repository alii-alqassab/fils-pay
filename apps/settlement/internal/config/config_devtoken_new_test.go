package config

import "testing"

func TestRequireInternalTokenRejectsDevTokenInProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	if err := (Config{InternalToken: "dev-token"}).RequireInternalToken(); err == nil {
		t.Fatal("expected error for dev-token in production")
	}
	if err := (Config{InternalToken: "real"}).RequireInternalToken(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_ENV", "development")
	if err := (Config{InternalToken: "dev-token"}).RequireInternalToken(); err != nil {
		t.Fatal(err)
	}
}
