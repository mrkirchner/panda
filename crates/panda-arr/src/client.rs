use reqwest::{Client, Method, RequestBuilder};
use serde::{Serialize, de::DeserializeOwned};
use url::Url;

use crate::{Error, Result};

/// Shared HTTP plumbing for *arr apps: base URL (including any URL base like `/radarr`),
/// `X-Api-Key` auth and error mapping.
#[derive(Debug, Clone)]
pub struct ArrClient {
    service: &'static str,
    http: Client,
    base: Url,
    api_key: String,
}

impl ArrClient {
    pub fn new(service: &'static str, base_url: &str, api_key: impl Into<String>) -> Result<Self> {
        // A trailing slash makes `Url::join` append instead of replacing the last segment.
        let mut base = Url::parse(base_url)?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self { service, http: Client::new(), base, api_key: api_key.into() })
    }

    pub fn url(&self, path: &str) -> Result<Url> {
        Ok(self.base.join(path.trim_start_matches('/'))?)
    }

    fn request(&self, method: Method, path: &str) -> Result<RequestBuilder> {
        Ok(self.http.request(method, self.url(path)?).header("X-Api-Key", &self.api_key))
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T> {
        self.send(self.request(Method::GET, path)?.query(query)).await
    }

    pub async fn post<B: Serialize + ?Sized, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T> {
        self.send(self.request(Method::POST, path)?.json(body)).await
    }

    pub async fn put<B: Serialize + ?Sized, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T> {
        self.send(self.request(Method::PUT, path)?.json(body)).await
    }

    /// A PATCH with query parameters and no body, whose answer has no body worth reading
    /// (Bazarr's actions).
    pub async fn patch_query(&self, path: &str, query: &[(&str, &str)]) -> Result<()> {
        let resp = self.request(Method::PATCH, path)?.query(query).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Status { service: self.service, status, body });
        }
        Ok(())
    }

    /// A DELETE whose answer has no body worth reading.
    pub async fn delete(&self, path: &str, query: &[(&str, &str)]) -> Result<()> {
        let resp = self.request(Method::DELETE, path)?.query(query).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Status { service: self.service, status, body });
        }
        Ok(())
    }

    async fn send<T: DeserializeOwned>(&self, req: RequestBuilder) -> Result<T> {
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Status { service: self.service, status, body });
        }
        Ok(serde_json::from_slice(&crate::read_capped(resp, crate::MAX_RESPONSE_BYTES).await?)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_paths_under_url_base() {
        let c = ArrClient::new("radarr", "http://nas:7878/radarr", "k").unwrap();
        assert_eq!(c.url("/api/v3/movie").unwrap().as_str(), "http://nas:7878/radarr/api/v3/movie");
        let c = ArrClient::new("sonarr", "http://nas:8989", "k").unwrap();
        assert_eq!(c.url("api/v3/series").unwrap().as_str(), "http://nas:8989/api/v3/series");
    }
}
